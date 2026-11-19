import { describe, expect, it } from 'vitest';
import { appendFileSync, readFileSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { baseCost, baseEq } from '../src/base-cost.js';
import type { LimitSample } from '../src/calibration.js';
import { readConfig, writeConfig } from '../src/config.js';
import { eventsOutput, mergeOutputs } from '../src/events.js';
import { advance, freshState } from '../src/guard-state.js';
import { buildHistory } from '../src/history.js';
import { logSample } from '../src/limits-log.js';
import { loadSessions } from '../src/transcripts/scan.js';
import { fakeClaudeDir, L, tmp } from './helpers.js';

const T = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, '0')}.000Z`;
const sample = (ts: string, five: number, cost: number, session = 's1'): LimitSample => ({ ts, session, model: 'm', cost, five, fiveReset: 1 });

describe('limits log', () => {
  it('appends only when %, cost or reset changes for the session', () => {
    const file = join(tmp(), 'limits.jsonl');
    const now = new Date('2026-01-01T12:00:00Z');
    expect(logSample(file, sample(T(1), 10, 1), now)).toBe(true);
    expect(logSample(file, sample(T(2), 10, 1), now)).toBe(false);
    expect(logSample(file, sample(T(3), 10, 1, 's2'), now)).toBe(true);
    expect(logSample(file, sample(T(4), 11, 1.5), now)).toBe(true);
    expect(readFileSync(file, 'utf8').trim().split('\n')).toHaveLength(3);
  });

  it('drops samples older than 30 days', () => {
    const file = join(tmp(), 'limits.jsonl');
    writeFileSync(file, JSON.stringify(sample('2025-11-01T00:00:00Z', 1, 1)) + '\n' + JSON.stringify(sample('2025-12-20T00:00:00Z', 2, 2)) + '\n');
    logSample(file, sample('2026-01-01T00:00:00Z', 3, 3), new Date('2026-01-01T00:00:00Z'));
    const left = readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l).five);
    expect(left).toEqual([2, 3]);
  });
});

describe('index cache', () => {
  it('is rewritten only when a transcript changed', () => {
    const claudeDir = fakeClaudeDir({ a: { main: [L.prompt('hi', T(0)), L.reply('1', T(1))] } });
    const cacheFile = join(tmp(), 'index.json');
    loadSessions({ claudeDir, cacheFile });
    utimesSync(cacheFile, new Date(0), new Date(0));
    loadSessions({ claudeDir, cacheFile });
    expect(statSync(cacheFile).mtimeMs).toBe(0);
    appendFileSync(join(claudeDir, 'projects', 'C--work-demo', 'a.jsonl'), L.reply('2', T(2)) + '\n');
    loadSessions({ claudeDir, cacheFile });
    expect(statSync(cacheFile).mtimeMs).toBeGreaterThan(0);
  });
});

describe('config', () => {
  it('moves hook.json into config.json once and ignores retired keys', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'hook.json'), JSON.stringify({ enabled: true, threshold: 1234 }));
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ guardEnabled: true, longSessionTokens: 5 }));
    const c = readConfig(dir);
    expect(c).toMatchObject({ hookEnabled: true, hookThreshold: 1234, guardEnabled: true, contextWarnPercent: 70 });
    expect('longSessionTokens' in c).toBe(false);
    writeConfig(dir, { hookEnabled: false });
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toEqual({ guardEnabled: true, hookEnabled: false, hookThreshold: 1234 });
  });
});

describe('events (one process per hook event)', () => {
  it('returns at once without reading stdin when hook and guard are off', async () => {
    let read = false;
    const out = await eventsOutput(tmp(), async () => ((read = true), '{}'), () => []);
    expect(out).toBe('');
    expect(read).toBe(false);
  });

  it('runs the guard and merges messages', async () => {
    const dir = tmp();
    writeConfig(dir, { guardEnabled: true, sessionBudgetTokens: 100, sessionWarnTokens: 50 });
    const transcript = join(tmp(), 't.jsonl');
    writeFileSync(transcript, [L.prompt('go', T(0)), L.reply('a', T(1), { input: 0, output: 20 })].join('\n') + '\n');
    const input = JSON.stringify({ session_id: 's1', transcript_path: transcript, hook_event_name: 'PostToolBatch', prompt: 'x' });
    const out = JSON.parse(await eventsOutput(dir, async () => input, () => []));
    expect(out.hookSpecificOutput.hookEventName).toBe('PostToolBatch');
    expect(out.systemMessage).toContain('session budget exceeded');
    expect(JSON.parse(mergeOutputs(['{"systemMessage":"a"}', '', '{"systemMessage":"b","hookSpecificOutput":{"x":1}}']))).toEqual({
      systemMessage: 'a · b',
      hookSpecificOutput: { x: 1 },
    });
  });
});

describe('advance', () => {
  it('reads only new complete lines, skips repeated blocks, and starts over on a new or shorter transcript', () => {
    const dir = tmp();
    const t1 = join(dir, 'a.jsonl');
    writeFileSync(t1, [L.prompt('go', T(0)), L.reply('a', T(1), { input: 0, output: 10 }), L.reply('a', T(1), { input: 0, output: 10 })].join('\n') + '\n');
    const s = advance(freshState(), t1);
    expect(s.eq).toBe(50);
    appendFileSync(t1, L.reply('b', T(2), { input: 0, read: 1000, output: 0 }).slice(0, 20)); // incomplete line
    expect(advance(s, t1).eq).toBe(50);
    const t2 = join(dir, 'b.jsonl'); // e.g. after /clear: a new transcript
    writeFileSync(t2, L.reply('c', T(3), { input: 0, output: 1 }) + '\n');
    expect(advance(s, t2)).toMatchObject({ eq: 5, transcript: t2 });
    writeFileSync(t1, L.reply('d', T(4), { input: 0, output: 2 }) + '\n');
    const back = advance({ ...s, transcript: t1, offset: 10_000 }, t1);
    expect(back.eq).toBe(10);
  });
});

describe('base cost', () => {
  it('measures the fixed context from the first response of recent sessions', () => {
    const opening = (id: string) => [L.prompt('hello there', T(0), { sessionId: id }), L.reply(`${id}1`, T(1), { input: 2, w1h: 20_000, read: 30_000, output: 100 }), L.reply(`${id}2`, T(2), { input: 2, read: 50_000 })];
    const sessions = ['x', 'y', 'z'].map((id) => opening(id));
    const claudeDir = fakeClaudeDir(Object.fromEntries(sessions.map((m, i) => [`s${i}`, { main: m }])));
    const rows = buildHistory(loadSessions({ claudeDir }), {}).tasks;
    const b = baseCost(rows, '/work/demo')!;
    expect(b).toMatchObject({ tokens: 50_002, sameProject: true, sessions: 3 });
    expect(b.startEq).toBeCloseTo(2 + 40_000 + 3_000);
    expect(baseEq(b, 2, true)).toBeCloseTo(b.startEq + 5_000.2);
    expect(baseCost(rows.slice(0, 2), '/work/demo')).toBeNull();
  });
});

import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { existsSync, readFileSync } from 'node:fs';
import { parseSession, promptText } from '../src/transcripts/parse.js';
import { loadSessions } from '../src/transcripts/scan.js';
import { totalUsage } from '../src/transcripts/types.js';
import { L, fakeClaudeDir, tmp } from './helpers.js';

const T = (m: number) => `2026-01-01T10:${String(m).padStart(2, '0')}:00.000Z`;

describe('parseSession', () => {
  it('splits tasks on real prompts and deduplicates repeated response lines', () => {
    const s = parseSession(
      [
        L.title('Fix login'),
        L.prompt('fix the login bug', T(0)),
        L.reply('a', T(1), { input: 5, read: 1000, w1h: 200, output: 50 }),
        L.reply('a', T(1), { input: 5, read: 1000, w1h: 200, output: 50 }), // same message, another block
        L.toolResult(T(2)),
        L.reply('b', T(3), { input: 1, read: 1200, output: 30 }),
        L.prompt('now add tests', T(5)),
        L.reply('c', T(6)),
        '{broken json',
      ].join('\n'),
    )!;
    expect(s.title).toBe('Fix login');
    expect(s.tasks).toHaveLength(2);
    const [t0] = s.tasks;
    expect(t0!.turns).toBe(2);
    expect(totalUsage(t0!.usageByModel)).toEqual({ input: 6, cacheWrite5m: 0, cacheWrite1h: 200, cacheRead: 2200, output: 80 });
    expect(t0!.initialContext).toBe(1205);
    expect(t0!.prompt).toBeUndefined();
    expect(t0!.terms).toEqual(['fix', 'login', 'bug']);
  });

  it('attributes subagent usage to the task running at that time', () => {
    const s = parseSession([L.prompt('one', T(0)), L.reply('a', T(1)), L.prompt('two', T(10)), L.reply('b', T(11))].join('\n'), [
      [L.reply('x', T(12), { output: 1000 }), L.reply('y', T(13), { output: 1000 })].join('\n'),
    ])!;
    expect(s.tasks[0]!.subagents).toBe(0);
    expect(s.tasks[1]!.subagents).toBe(1);
    expect(s.tasks[1]!.subagentUsage.output).toBe(2000);
    expect(s.tasks[1]!.turns).toBe(1);
  });

  it('reads slash commands as prompts and ignores meta and local output', () => {
    expect(promptText({ type: 'user', message: { content: '<command-name>/review</command-name><command-args>auth</command-args>' } })).toBe('/review auth');
    expect(promptText({ type: 'user', message: { content: '<local-command-stdout>x</local-command-stdout>' } })).toBeNull();
    expect(promptText({ type: 'user', isMeta: true, message: { content: 'hello' } })).toBeNull();
  });

  it('keeps reported cost and returns null for sessions without prompts', () => {
    expect(parseSession(L.title('x'))).toBeNull();
    const s = parseSession([L.prompt('a', T(0)), L.reply('a', T(1)), L.cost('claude-test-1', 1.5)].join('\n'))!;
    expect(s.reportedCost).toEqual({ 'claude-test-1': { costUSD: 1.5 } });
  });
});

describe('loadSessions', () => {
  it('finds sessions with subagents and caches them without prompt text', () => {
    const dir = fakeClaudeDir({
      s1: { main: [L.prompt('secret plan text', T(0)), L.reply('a', T(1))], subagents: [[L.reply('z', T(2))]] },
    });
    const cacheFile = join(tmp(), 'index.json');
    const first = loadSessions({ claudeDir: dir, cacheFile });
    expect(first).toHaveLength(1);
    expect(first[0]!.tasks[0]!.subagents).toBe(1);
    expect(existsSync(cacheFile)).toBe(true);
    expect(readFileSync(cacheFile, 'utf8')).not.toContain('secret plan text');
    expect(loadSessions({ claudeDir: dir, cacheFile })).toEqual(first);
    const withText = loadSessions({ claudeDir: dir, cacheFile, keepPrompts: true });
    expect(withText[0]!.tasks[0]!.prompt).toBe('secret plan text');
  });

  it('returns nothing when there is no projects folder', () => {
    expect(loadSessions({ claudeDir: tmp() })).toEqual([]);
  });
});

describe('session totals', () => {
  it('counts a pasted-content prompt as a request', () => {
    expect(promptText({ type: 'user', message: { content: '\n\n<pasted_content id="x">\nreview this\n</pasted_content>' } })).not.toBeNull();
    expect(promptText({ type: 'user', message: { content: '<local-command-stdout>ok</local-command-stdout>' } })).toBeNull();
  });

  it('the session total is the sum of every response; tasks (plus untitled) only break it down', () => {
    const s = parseSession(
      [
        L.reply('pre', T(0), { input: 3, read: 500, output: 7 }),
        L.prompt('<system-reminder>not a request</system-reminder>', T(1)),
        L.reply('x', T(2), { input: 2, read: 900, w1h: 40, output: 20 }),
        L.prompt('do the thing', T(3)),
        L.reply('y', T(4), { input: 1, read: 1000, output: 30 }),
        L.reply('y', T(4), { input: 1, read: 1000, output: 30 }),
      ].join('\n'),
      [L.reply('sub', T(0), { input: 4, output: 9 })],
    )!;
    expect(s.tasks[0]!.untitled).toBe(true);
    const sum = totalUsage({});
    for (const t of s.tasks) for (const u of Object.values(t.usageByModel)) for (const k of Object.keys(u) as (keyof typeof u)[]) sum[k] += u[k];
    expect(sum).toEqual(totalUsage(s.usageByModel));
    expect(totalUsage(s.usageByModel).output).toBe(7 + 20 + 30 + 9);
  });
});

import { toUsage } from '../src/transcripts/parse.js';

describe('toUsage cache writes (review finding 8)', () => {
  it('counts the 5-minute writes as total minus 1h when the 5m field is missing', () => {
    const base = { input_tokens: 1, cache_creation_input_tokens: 300 };
    expect(toUsage({ ...base, cache_creation: { ephemeral_1h_input_tokens: 100 } })).toMatchObject({ cacheWrite5m: 200, cacheWrite1h: 100 });
    expect(toUsage({ ...base, cache_creation: {} })).toMatchObject({ cacheWrite5m: 300, cacheWrite1h: 0 });
    expect(toUsage(base)).toMatchObject({ cacheWrite5m: 300, cacheWrite1h: 0 });
    expect(toUsage({ ...base, cache_creation: { ephemeral_5m_input_tokens: 50, ephemeral_1h_input_tokens: 250 } })).toMatchObject({ cacheWrite5m: 50, cacheWrite1h: 250 });
  });
});

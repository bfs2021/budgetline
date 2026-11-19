import { describe, expect, it } from 'vitest';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { evaluate, logEstimate, measuredBias, readLog, type EstimateLog } from '../src/accuracy.js';
import { comparableRows, currentSession } from '../src/comparable.js';
import { renderEstimate, runEstimate, estimateJson } from '../src/estimate-cmd.js';
import { buildHistory, type TaskRow } from '../src/history.js';
import { isEstimateRequest } from '../src/text.js';
import { parseSession } from '../src/transcripts/parse.js';
import type { Session } from '../src/transcripts/types.js';
import { L, tmp } from './helpers.js';

const T = (d: number, m: number) => `2026-01-0${d}T${String(10 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00.000Z`;
const DESC = 'rename the export module and update the build';

/** A finished session of 8 similar, expensive tasks (day 1) in /work/demo. */
function past(): Session {
  const lines = [L.cost('claude-test-1', 10)];
  for (let i = 0; i < 8; i++) lines.push(L.prompt(`rename the export module part ${i}`, T(1, i * 2)), L.reply(`p${i}`, T(1, i * 2 + 1), { input: 500_000 }));
  return parseSession(lines.join('\n'))!;
}

/** The session running now (day 2): /estimate requests with the same words, plus a small finished task. */
function current(id = 's2'): Session {
  const x = { sessionId: id };
  const lines = [
    L.prompt(`<command-name>/budgetline:estimate</command-name><command-args>${DESC}</command-args>`, T(2, 0), x),
    L.reply('e1', T(2, 1), { input: 100 }),
    L.prompt(`<command-name>/estimate</command-name><command-args>${DESC}</command-args>`, T(2, 2), x),
    L.reply('e2', T(2, 3), { input: 100 }),
    L.prompt(DESC, T(2, 4), x),
    L.reply('e3', T(2, 5), { input: 200 }),
  ];
  return parseSession(lines.join('\n'))!;
}

describe('estimate never compares a task with itself (a)', () => {
  it('recognises /estimate requests in every form, and nothing else', () => {
    for (const t of ['/estimate fix x', '/budgetline:estimate fix x', 'budgetline:estimate fix x', '/estimate']) expect(isEstimateRequest(t)).toBe(true);
    for (const t of ['estimate the cost of the migration', 'fix /estimate output', '/estimated']) expect(isEstimateRequest(t)).toBe(false);
  });

  it('flags /estimate tasks and leaves them out, with the current session', () => {
    const sessions = [past(), current()];
    const rows = buildHistory(sessions, {}).tasks;
    expect(rows.filter((r) => r.estimate)).toHaveLength(2);
    const r = runEstimate(sessions, DESC, '/work/demo', null, false, { session: 's2' })!;
    expect(r.est.basis.rows.every((x) => x.sessionId !== 's2')).toBe(true);
    expect(r.eq.typical).toBeGreaterThan(400_000);
  });

  it('without an id, takes the latest session in the project as current only if active in the last 10 minutes', () => {
    const rows = buildHistory([past(), current()], {}).tasks;
    const x = { project: '/work/demo' };
    expect(currentSession(rows, { ...x, now: new Date('2026-01-02T10:09:00Z') })).toBe('s2');
    expect(currentSession(rows, { ...x, now: new Date('2026-01-02T11:00:00Z') })).toBeUndefined();
    const later = comparableRows(rows, { ...x, now: new Date('2026-01-02T11:00:00Z') });
    expect(later.some((r) => r.estimate)).toBe(false);
    expect(later.some((r) => r.sessionId === 's2')).toBe(true);
  });

  it('accuracy pairs an estimate with the next real task, skipping /estimate requests', () => {
    const rows = buildHistory([current()], {}).tasks;
    const log: EstimateLog[] = [{ ts: '2026-01-02T09:59:00Z', project: '/work/demo', low: 100, typical: 200, high: 2000 }];
    expect(evaluate(log, rows)).toMatchObject({ n: 1, within: 1 });
    expect(rows.find((r) => !r.estimate)!.eq).toBe(700);
  });
});

describe('measured bias corrects the estimate (d)', () => {
  const row = (start: string, eq: number): TaskRow => ({ start, end: start, eq, project: '/work/demo', sessionId: 's', estimate: false }) as TaskRow;
  const at = (h: number) => `2026-01-01T${String(h).padStart(2, '0')}:00:00.000Z`;
  const rows = [row(at(1) .replace(':00:00', ':05:00'), 1_000_000), row(at(4).replace(':00:00', ':05:00'), 900_000), row(at(7).replace(':00:00', ':05:00'), 1_100_000)];

  it('needs 3 checked estimates and uses the median of actual / raw estimate', () => {
    const file = join(tmp(), 'estimates.jsonl');
    logEstimate(file, '/work/demo', { low: 52_000, typical: 180_000, high: 1_000_000 }, new Date(at(1)));
    logEstimate(file, '/work/demo', { low: 52_000, typical: 180_000, high: 1_000_000 }, new Date(at(4)));
    expect(measuredBias(readLog(file), rows)).toBeNull();
    // an already corrected estimate is measured against its raw typical
    logEstimate(file, '/work/demo', { low: 300_000, typical: 1_000_000, high: 5_000_000 }, new Date(at(7)), 200_000);
    const b = measuredBias(readLog(file), rows)!;
    expect(b.n).toBe(3);
    expect(b.factor).toBeCloseTo(5.5, 5); // ratios 5.56, 5.0 and 1.1M/200k = 5.5 (raw, not 1.1)
  });

  it('reads logs written before the raw field existed', () => {
    const file = join(tmp(), 'estimates.jsonl');
    const old = (h: number) => JSON.stringify({ ts: at(h), project: '/work/demo', low: 52_000, typical: 180_000, high: 1_000_000 });
    writeFileSync(file, [old(1), old(4), old(7)].join('\n') + '\n');
    expect(measuredBias(readLog(file), rows)!.factor).toBeCloseTo(1_000_000 / 180_000, 5);
  });

  it('scales typical and range, says so, and keeps the raw figure', () => {
    const sessions = [past()];
    const plain = runEstimate(sessions, DESC, tmp(), null, false)!;
    const log: EstimateLog[] = [1, 4, 7].map((h) => ({ ts: at(h), project: '/work/demo', low: 1, typical: 180_000, high: 2 }));
    expect(runEstimate(sessions, DESC, tmp(), null, false, { log })!.bias).toBeNull(); // no task after those estimates
    const k = 1_000_000 / 180_000;
    const withRows = runEstimate([past(), parseSession(rows2())!], DESC, tmp(), null, false, { log })!;
    expect(withRows.bias?.factor).toBeCloseTo(k, 5);
    expect(withRows.eq.typical).toBeCloseTo(withRows.rawTypical * k, 0);
    expect(withRows.rawTypical).toBeCloseTo(plain.eq.typical, -4);
    expect(renderEstimate(withRows)).toMatch(/Corrected ×5\.6 for measured bias: your last 3 checked estimates came out low/);
    expect(JSON.parse(estimateJson(withRows)).biasFactor).toBeCloseTo(k, 5);
  });

  /** One task per estimate, 5 minutes after it, each costing 1M equivalent (input only). */
  function rows2(): string {
    const x = { sessionId: 's9' };
    return [1, 4, 7].flatMap((h) => [L.prompt('unrelated words zebra', at(h).replace(':00:00', ':05:00'), x), L.reply(`z${h}`, at(h).replace(':00:00', ':06:00'), { input: 1_000_000 - 500, output: 100 })]).join('\n');
  }
});

describe('index cache migration', () => {
  it('ignores a cache from an older version and rebuilds it with the /estimate flag', async () => {
    const { readFileSync } = await import('node:fs');
    const { CACHE_VERSION, loadSessions } = await import('../src/transcripts/scan.js');
    const { fakeClaudeDir } = await import('./helpers.js');
    const dir = fakeClaudeDir({ s1: { main: [L.prompt('/estimate fix it', T(1, 0)), L.reply('a', T(1, 1))] } });
    const cacheFile = join(tmp(), 'index-v1.json');
    const main = join(dir, 'projects', 'C--work-demo', 's1.jsonl');
    writeFileSync(cacheFile, JSON.stringify({ version: 4, entries: { [main]: { sig: 'stale', session: null } } }));
    const [s] = loadSessions({ claudeDir: dir, cacheFile });
    expect(s!.tasks[0]!.estimate).toBe(true);
    expect(JSON.parse(readFileSync(cacheFile, 'utf8')).version).toBe(CACHE_VERSION);
  });
});

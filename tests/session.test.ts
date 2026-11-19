import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { readSamples } from '../src/calibration.js';
import { buildHistory } from '../src/history.js';
import { renderHistory } from '../src/render-history.js';
import { pickSession, sessionFigures } from '../src/session-cmd.js';
import { sessionLine } from '../src/session-line.js';
import { run, type Paths } from '../src/statusline.js';
import { loadSessions } from '../src/transcripts/scan.js';
import { L, fakeClaudeDir, tmp } from './helpers.js';

const T = (m: number) => `2026-01-01T10:0${m}:00.000Z`;
const MAIN = [L.prompt('fix the parser', T(0)), L.reply('a', T(1), { input: 10, read: 50_000, w1h: 20_000, output: 900 }), L.reply('b', T(2), { read: 70_000, output: 1_200 })];
const SUB = [[L.reply('sub1', T(1), { input: 3_000, output: 400 })]];

function world(main: string[]) {
  const claude = fakeClaudeDir({ s1: { main, subagents: SUB } });
  const data = tmp();
  const p: Paths = { settings: join(tmp(), 'settings.json'), data };
  const transcript = join(claude, 'projects', 'C--work-demo', 's1.jsonl');
  const all = () => loadSessions({ claudeDir: claude });
  return { p, data, transcript, all };
}

const statusInput = (transcript: string, cost: number) =>
  JSON.stringify({
    session_id: 's1',
    transcript_path: transcript,
    cost: { total_cost_usd: cost },
    rate_limits: { five_hour: { used_percentage: 23.4, resets_at: 1 }, seven_day: { used_percentage: 41, resets_at: 2 } },
    context_window: { used_percentage: 37 },
  });

describe('one session, one set of figures', () => {
  it('status line, `session` and `history` agree while the session runs (no cost-state yet)', () => {
    const w = world(MAIN);
    const line = run(statusInput(w.transcript, 1.2345), w.p);
    const all = w.all();
    const samples = readSamples(join(w.data, 'limits.jsonl'));
    const f = sessionFigures(pickSession(all)!, all, samples, w.data);
    expect(sessionLine(f)).toBe(line);
    expect(line).toBe('5h: 23% · 7d: 41% · $1.23 API value this session · Equiv 68k');
    const out = renderHistory(buildHistory(all, {}, new Map([['s1', 1.2345]])), { limit: 5, showPrompts: false, plan: true });
    const row = out.split('\n').find((l) => l.startsWith('s1'))!;
    expect(row).toMatch(/68k\s+\$1\.23$/);
  });

  it('after the session ends, the recorded cost-state is the same figure in both views', () => {
    const w = world([...MAIN, L.cost('claude-test-1', 1.2345)]);
    const all = w.all();
    const f = sessionFigures(all[0]!, all, [], w.data);
    expect(sessionLine(f)).toBe('$1.23 this session · Equiv 68k');
    expect(renderHistory(buildHistory(all, {}), { limit: 5, showPrompts: false })).toMatch(/68k\s+\$1\.23\n/);
  });

  it("marks an estimate with '~' in both views when no cost was ever reported", () => {
    const other = { main: [L.prompt('x', T(0), { sessionId: 's0' }), L.reply('z', T(1), { input: 1000 }), L.cost('claude-test-1', 0.5)] };
    const claude = fakeClaudeDir({ s0: other, s1: { main: MAIN.map((l) => l) } });
    const all = loadSessions({ claudeDir: claude });
    const s1 = pickSession(all, 's1')!;
    const f = sessionFigures(s1, all, [], tmp());
    expect(f.approx).toBe(true);
    expect(sessionLine(f)).toMatch(/^~\$\S+ this session · Equiv 63k$/);
    const money = sessionLine(f).split(' ')[0]!;
    expect(renderHistory(buildHistory(all, {}), { limit: 5, showPrompts: false })).toContain(money);
  });
});

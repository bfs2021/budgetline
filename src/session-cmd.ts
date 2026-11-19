import { join } from 'node:path';
import { str, type Parsed } from './args.js';
import { hasPlanLimits, readSamples, type LimitSample } from './calibration.js';
import { learnPrices, sessionCost, sessionEquivalent } from './cost.js';
import { load } from './data.js';
import { projectName, truncate } from './format.js';
import { guardFigure } from './guard.js';
import { lastSample } from './limits-log.js';
import { dataDir } from './paths.js';
import { sessionLine, type SessionFigures } from './session-line.js';
import type { Session } from './transcripts/types.js';

/** The session with `id` (a prefix is enough), else the one with the latest activity. */
export function pickSession(sessions: Session[], id?: string): Session | undefined {
  if (id) return sessions.find((s) => s.id.startsWith(id));
  return [...sessions].sort((a, b) => (a.end < b.end ? 1 : -1))[0];
}

/** The same figures the status line shows, rebuilt from the transcripts and the status line log. */
export function sessionFigures(s: Session, all: Session[], samples: LimitSample[], dir: string): SessionFigures {
  const last = lastSample(samples, s.id);
  const cost = sessionCost(s, learnPrices(all), last?.cost);
  return {
    five: last?.five,
    seven: last?.seven,
    usd: cost.usd,
    approx: cost.source === 'estimated',
    plan: hasPlanLimits(samples),
    eq: sessionEquivalent(s),
    ctx: last?.ctx,
    guard: guardFigure(dir, s.id),
  };
}

export function renderSession(s: Session, f: SessionFigures, last?: LimitSample): string {
  const head = `Session ${s.id.slice(0, 8)}${s.title ? ` ${truncate(s.title, 40)}` : ''} (${projectName(s.project)}, ${s.start.slice(0, 16).replace('T', ' ')})`;
  const source = last
    ? `5h/7d, ctx and $ are the last values the status line saw (${last.ts.slice(0, 19).replace('T', ' ')} UTC); Equiv is read from the transcripts now.`
    : f.approx
      ? "No status line snapshot or recorded cost for this session: '~$' is an estimate from its tokens. Install the wrapper (budgetline statusline install) to compare live."
      : 'No status line snapshot for this session: $ is the cost Claude Code recorded in the transcript.';
  return [head, sessionLine(f), '', source].join('\n');
}

export function sessionCommand(p: Parsed): string {
  const all = load(p);
  const s = pickSession(all, str(p, 'id'));
  if (!s) return 'No Claude Code session found.';
  const dir = dataDir();
  const samples = readSamples(join(dir, 'limits.jsonl'));
  const f = sessionFigures(s, all, samples, dir);
  return p.flags.json ? JSON.stringify({ id: s.id, ...f, line: sessionLine(f) }, null, 2) : renderSession(s, f, lastSample(samples, s.id));
}

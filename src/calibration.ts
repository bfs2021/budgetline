import { readJsonl } from './jsonl.js';

/** One status line snapshot. Metrics only: no prompt or response text. */
export interface LimitSample {
  ts: string;
  /** Session id, needed to pair snapshots of the same session. */
  session: string;
  model: string;
  /** Cumulative session cost in USD. */
  cost: number;
  five?: number;
  fiveReset?: number;
  seven?: number;
  sevenReset?: number;
  /** Context window used, %. */
  ctx?: number;
}

export interface Calibration {
  /** Percentage points of the 5-hour limit per USD of spend. */
  fivePerUsd: number;
  sevenPerUsd: number | null;
  pairs: number;
  usd: number;
}

const MIN_PAIRS = 10;
const MIN_USD = 1;

export function readSamples(file: string): LimitSample[] {
  return readJsonl<LimitSample>(file);
}

/** True once the status line has seen usage-limit % data: a Pro/Max plan, not pay-as-you-go API. */
export function hasPlanLimits(samples: LimitSample[]): boolean {
  return samples.some((s) => typeof s.five === 'number' || typeof s.seven === 'number');
}

/** What the $ means for this user: plan (limit %, $ is API-equivalent value) or API (real cost). */
export function readBilling(file: string): { calibration: Calibration | null; plan: boolean } {
  const samples = readSamples(file);
  return { calibration: calibrate(samples), plan: hasPlanLimits(samples) };
}

type Window = 'five' | 'seven';

/** Sum of limit % and cost increments between consecutive snapshots of the same session and window. */
function deltas(samples: LimitSample[], w: Window): { pct: number; usd: number; pairs: number } {
  const bySession = new Map<string, LimitSample[]>();
  for (const s of samples) {
    const list = bySession.get(s.session);
    if (list) list.push(s);
    else bySession.set(s.session, [s]);
  }
  const acc = { pct: 0, usd: 0, pairs: 0 };
  const reset = w === 'five' ? 'fiveReset' : 'sevenReset';
  for (const list of bySession.values()) {
    list.sort((a, b) => (a.ts < b.ts ? -1 : 1));
    for (let i = 1; i < list.length; i++) addPair(acc, list[i - 1]!, list[i]!, w, reset);
  }
  return acc;
}

function addPair(acc: { pct: number; usd: number; pairs: number }, a: LimitSample, b: LimitSample, w: Window, reset: 'fiveReset' | 'sevenReset'): void {
  const dc = b.cost - a.cost;
  const dp = (b[w] ?? NaN) - (a[w] ?? NaN);
  if (a[reset] !== b[reset] || !(dc > 0) || !(dp >= 0)) return;
  acc.pct += dp;
  acc.usd += dc;
  acc.pairs++;
}

/** Null until there are enough paired snapshots to say anything. */
export function calibrate(samples: LimitSample[]): Calibration | null {
  const five = deltas(samples, 'five');
  if (five.pairs < MIN_PAIRS || five.usd < MIN_USD) return null;
  const seven = deltas(samples, 'seven');
  return {
    fivePerUsd: five.pct / five.usd,
    sevenPerUsd: seven.pairs >= MIN_PAIRS && seven.usd >= MIN_USD ? seven.pct / seven.usd : null,
    pairs: five.pairs,
    usd: five.usd,
  };
}

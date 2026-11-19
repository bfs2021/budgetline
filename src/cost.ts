import { totalUsage, type Session, type Task, type Usage } from './transcripts/types.js';

/**
 * Price of each token kind relative to a plain input token (standard Claude API ratios).
 * "Equivalent tokens" = sum of tokens × weight: one number that tracks spend.
 */
export const WEIGHTS = { input: 1, cacheWrite5m: 1.25, cacheWrite1h: 2, cacheRead: 0.1, output: 5 } as const;

export function equivalent(u: Usage): number {
  return (
    u.input * WEIGHTS.input +
    u.cacheWrite5m * WEIGHTS.cacheWrite5m +
    u.cacheWrite1h * WEIGHTS.cacheWrite1h +
    u.cacheRead * WEIGHTS.cacheRead +
    u.output * WEIGHTS.output
  );
}

/** Equivalent tokens of a whole session (main + subagents): the one "Equiv" every view shows. */
export function sessionEquivalent(s: Pick<Session, 'usageByModel'>): number {
  return equivalent(totalUsage(s.usageByModel));
}

export function taskEquivalent(t: Task): number {
  let sum = 0;
  for (const u of Object.values(t.usageByModel)) sum += equivalent(u);
  return sum;
}

/** USD per equivalent token, per model. */
export type Prices = Record<string, number>;

/**
 * Effective price per model, learned from the real cost Claude Code reports in each
 * session (`cost-state`) divided by the equivalent tokens seen in that session's transcript.
 * No bundled price table: a model never seen with a reported cost has no price.
 */
export function learnPrices(sessions: Session[]): Prices {
  const cost: Record<string, number> = {};
  const eq: Record<string, number> = {};
  for (const s of sessions) {
    if (!s.reportedCost) continue;
    addSessionEq(s, eq);
    for (const [m, c] of Object.entries(s.reportedCost)) cost[m] = (cost[m] ?? 0) + c.costUSD;
  }
  const prices: Prices = {};
  for (const [m, e] of Object.entries(eq)) if (e > 0 && cost[m]) prices[m] = cost[m]! / e;
  return prices;
}

function addSessionEq(s: Session, eq: Record<string, number>): void {
  for (const [m, u] of Object.entries(s.usageByModel)) {
    if (s.reportedCost?.[m]?.costUSD) eq[m] = (eq[m] ?? 0) + equivalent(u);
  }
}

/** USD cost of a task, or null when one of its models has no learned price. */
export function taskCost(t: Pick<Task, 'usageByModel'>, prices: Prices): number | null {
  let usd = 0;
  for (const [m, u] of Object.entries(t.usageByModel)) {
    const e = equivalent(u);
    if (e === 0) continue;
    const p = prices[m];
    if (p === undefined) return null;
    usd += e * p;
  }
  return usd;
}

/** Linear-interpolated percentile (q in 0..1) of an unsorted list. */
export function percentile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const v = [...values].sort((a, b) => a - b);
  const pos = (v.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return v[lo]! + (v[hi]! - v[lo]!) * (pos - lo);
}

/**
 * A session's cost: what Claude Code reported, else estimated from its tokens. Reported means
 * the transcript's `cost-state` (written when a session ends) or, while it runs, the last
 * `cost.total_cost_usd` the status line saw (`live`); both are cumulative, so the larger wins.
 */
export function sessionCost(s: Session, prices: Prices, live?: number): { usd: number | null; source: 'reported' | 'estimated' } {
  const saved = s.reportedCost ? Object.values(s.reportedCost).reduce((a, c) => a + c.costUSD, 0) : undefined;
  if (saved !== undefined || live !== undefined) return { usd: Math.max(saved ?? 0, live ?? 0), source: 'reported' };
  return { usd: taskCost(s, prices), source: 'estimated' };
}

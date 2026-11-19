import { percentile } from './cost.js';
import type { TaskRow } from './history.js';
import { taskKind, terms, type TaskKind } from './text.js';

export interface Range {
  low: number;
  typical: number;
  high: number;
}

export interface Basis {
  /** 'similar': tasks that resemble the description; 'global': fallback distribution. */
  kind: 'similar' | 'global';
  rows: TaskRow[];
  avgSimilarity: number;
  sameProject: number;
  /** The 3 most similar tasks (empty for the global basis). */
  closest: TaskRow[];
}

export interface Estimate {
  basis: Basis;
  eq: Range;
  usd: Range | null;
  /** high / low > WIDE_RATIO */
  wide: boolean;
  /** Fewer than MIN_SIMILAR similar tasks. */
  fewData: boolean;
  medianTurns: number;
  /** Question or change: only past tasks of the same kind are compared. */
  taskKind: TaskKind;
}

const MIN_SIMILAR = 5;
export const WIDE_RATIO = 10;
const MIN_SIM = 0.12;
const MAX_SIMILAR = 25;
const SAME_PROJECT_BOOST = 1.25;

type Vec = Map<string, number>;

function idf(rows: TaskRow[]): Map<string, number> {
  const df = new Map<string, number>();
  for (const r of rows) for (const t of new Set(r.terms)) df.set(t, (df.get(t) ?? 0) + 1);
  const out = new Map<string, number>();
  for (const [t, n] of df) out.set(t, Math.log((rows.length + 1) / (n + 1)) + 1);
  return out;
}

function vector(ts: string[], weights: Map<string, number>): Vec {
  const v: Vec = new Map();
  for (const t of ts) v.set(t, (v.get(t) ?? 0) + (weights.get(t) ?? 1));
  return v;
}

function cosine(a: Vec, b: Vec): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (const [t, x] of a) {
    na += x * x;
    dot += x * (b.get(t) ?? 0);
  }
  for (const y of b.values()) nb += y * y;
  return na && nb ? dot / Math.sqrt(na * nb) : 0;
}

function sameProject(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/** Past tasks most similar to the description (TF-IDF cosine, same project boosted). */
function similarTasks(rows: TaskRow[], description: string, project: string): { row: TaskRow; sim: number }[] {
  const w = idf(rows);
  const q = vector(terms(description), w);
  return rows
    .map((row) => {
      const sim = cosine(q, vector(row.terms, w));
      return { row, sim: sameProject(row.project, project) ? sim * SAME_PROJECT_BOOST : sim };
    })
    .filter((x) => x.sim >= MIN_SIM)
    .sort((a, b) => b.sim - a.sim)
    .slice(0, MAX_SIMILAR);
}

function chooseBasis(rows: TaskRow[], description: string, project: string): Basis {
  const sim = similarTasks(rows, description, project);
  if (sim.length >= MIN_SIMILAR) {
    const avg = sim.reduce((a, x) => a + Math.min(x.sim, 1), 0) / sim.length;
    const same = sim.filter((x) => sameProject(x.row.project, project)).length;
    return { kind: 'similar', rows: sim.map((x) => x.row), avgSimilarity: avg, sameProject: same, closest: sim.slice(0, 3).map((x) => x.row) };
  }
  const local = rows.filter((r) => sameProject(r.project, project));
  const pool = local.length >= 20 ? local : rows;
  return { kind: 'global', rows: pool, avgSimilarity: 0, sameProject: pool === local ? local.length : 0, closest: [] };
}

function range(values: number[]): Range {
  return { low: percentile(values, 0.25), typical: percentile(values, 0.5), high: percentile(values, 0.9) };
}

/** Estimate from history alone (repo context is added by the caller). Null with no history. */
export function estimateFromHistory(rows: TaskRow[], description: string, project: string): Estimate | null {
  if (rows.length === 0) return null;
  const kind = taskKind(description);
  const sameKind = rows.filter((r) => r.kind === kind);
  const basis = chooseBasis(sameKind.length >= MIN_SIMILAR ? sameKind : rows, description, project);
  const eq = range(basis.rows.map((r) => r.eq));
  const priced = basis.rows.filter((r) => r.usd !== null);
  const usd = priced.length >= basis.rows.length / 2 ? range(priced.map((r) => r.usd!)) : null;
  return {
    basis,
    eq,
    usd,
    wide: eq.low > 0 ? eq.high / eq.low > WIDE_RATIO : true,
    fewData: basis.kind === 'global',
    medianTurns: percentile(basis.rows.map((r) => r.turns), 0.5),
    taskKind: kind,
  };
}

/** Add the same amount to every point of a range. */
export function shift(r: Range, by: number): Range {
  return { low: r.low + by, typical: r.typical + by, high: r.high + by };
}

/** USD per equivalent token across the basis (for converting extra context to dollars). */
export function basisPrice(rows: TaskRow[]): number | null {
  const priced = rows.filter((r) => r.usd !== null && r.eq > 0);
  const eq = priced.reduce((a, r) => a + r.eq, 0);
  return eq > 0 ? priced.reduce((a, r) => a + r.usd!, 0) / eq : null;
}

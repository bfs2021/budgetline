import { equivalent, percentile, WEIGHTS } from './cost.js';
import type { TaskRow } from './history.js';
import { promptTokens } from './transcripts/types.js';

/**
 * The fixed context every API call carries in a project: system prompt, tool definitions,
 * CLAUDE.md and rules, plugins, skills and memory. Measured from the first response of recent
 * sessions, where the conversation is still just the first prompt.
 */
export interface BaseCost {
  /** Tokens of fixed context (median prompt size of a session's first response). */
  tokens: number;
  /** Equivalent tokens of a session's first response: writing the uncached part + reading the rest. */
  startEq: number;
  /** Equivalent tokens each later call pays to re-read it from the cache. */
  perCallEq: number;
  /** Sessions measured, and whether they are from this project (else all projects). */
  sessions: number;
  sameProject: boolean;
}

const RECENT = 20;
const MIN_SESSIONS = 3;
/** Above this, the fixed context is worth trimming. */
export const HIGH_BASE_TOKENS = 40_000;

function openings(rows: TaskRow[]): TaskRow[] {
  return rows
    .filter((r) => r.opensSession && r.initialUsage && promptTokens(r.initialUsage) > 0)
    .sort((a, b) => (a.start < b.start ? 1 : -1))
    .slice(0, RECENT);
}

/** Null when fewer than 3 sessions have a recorded first response. */
export function baseCost(rows: TaskRow[], project: string): BaseCost | null {
  const own = openings(rows.filter((r) => r.project === project));
  const sameProject = own.length >= MIN_SESSIONS;
  const list = sameProject ? own : openings(rows);
  if (list.length < MIN_SESSIONS) return null;
  const tokens = percentile(list.map((r) => promptTokens(r.initialUsage!)), 0.5);
  return {
    tokens,
    startEq: percentile(list.map((r) => equivalent(r.initialUsage!)), 0.5),
    perCallEq: tokens * WEIGHTS.cacheRead,
    sessions: list.length,
    sameProject,
  };
}

/** Fixed-context share of a task with `turns` API calls; `fresh` adds the opening cache write. */
export function baseEq(b: BaseCost, turns: number, fresh: boolean): number {
  const calls = Math.max(1, turns);
  return fresh ? b.startEq + (calls - 1) * b.perCallEq : calls * b.perCallEq;
}

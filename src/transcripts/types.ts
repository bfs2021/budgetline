import type { TaskKind } from '../text.js';

/** Token counts for one or more API responses. */
export interface Usage {
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  output: number;
}

/** One user request and every response until the next one. */
export interface Task {
  /** Index within its session. */
  index: number;
  start: string;
  end: string;
  /** Normalized keyword terms (never the raw prompt text). */
  terms: string[];
  kind: TaskKind;
  /** Raw prompt text; only filled when explicitly requested (--show-prompts). */
  prompt?: string;
  usageByModel: Record<string, Usage>;
  /** Unique main-thread API responses. */
  turns: number;
  /** Subagent transcripts started during this task. */
  subagents: number;
  /** Equivalent tokens spent inside subagents (already included in usageByModel). */
  subagentUsage: Usage;
  /** Prompt size (input + cache) of the first response: the context the task starts with. */
  initialContext: number;
  /** Prompt side of the first response (input, cache writes, cache reads; output 0). */
  initialUsage?: Usage;
  /** The request was `/estimate …`: excluded from comparisons and accuracy matching. */
  estimate?: boolean;
  /** Responses before any detected request (no prompt to describe them). */
  untitled?: boolean;
}

export interface ModelCost {
  costUSD: number;
}

export interface Session {
  id: string;
  /** Working directory of the session. */
  project: string;
  title?: string;
  start: string;
  end: string;
  /** Tasks only break this down. */
  tasks: Task[];
  /** Session total: every deduplicated response (main + subagents), by model. */
  usageByModel: Record<string, Usage>;
  /** Real cost reported by Claude Code (`cost-state`), when present. */
  reportedCost?: Record<string, ModelCost>;
}

export function emptyUsage(): Usage {
  return { input: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0, output: 0 };
}

export function addUsage(into: Usage, u: Usage): void {
  into.input += u.input;
  into.cacheWrite5m += u.cacheWrite5m;
  into.cacheWrite1h += u.cacheWrite1h;
  into.cacheRead += u.cacheRead;
  into.output += u.output;
}

/** Prompt size of a response: everything it read (input + cache writes + cache reads). */
export function promptTokens(u: Usage): number {
  return u.input + u.cacheWrite5m + u.cacheWrite1h + u.cacheRead;
}

export function totalUsage(byModel: Record<string, Usage>): Usage {
  const t = emptyUsage();
  for (const u of Object.values(byModel)) addUsage(t, u);
  return t;
}

import { equivalent, learnPrices, sessionEquivalent, sessionCost, taskCost, taskEquivalent, WEIGHTS, type Prices } from './cost.js';
import type { TaskKind } from './text.js';
import { totalUsage, type Session, type Usage } from './transcripts/types.js';

export interface TaskRow {
  sessionId: string;
  sessionTitle?: string;
  project: string;
  start: string;
  /** Last response of the task. */
  end: string;
  /** A `/estimate` request: excluded from estimates and accuracy matching. */
  estimate: boolean;
  usage: Usage;
  eq: number;
  usd: number | null;
  turns: number;
  subagents: number;
  subagentEq: number;
  initialContext: number;
  /** Prompt side of the first response of the task. */
  initialUsage?: Usage;
  /** First task of its session: its first response paid the session's opening cache write. */
  opensSession: boolean;
  /** Share of the task's equivalent tokens spent writing the prompt cache. */
  cacheWriteShare: number;
  /** Normalized keyword terms, for similarity (not the prompt text). */
  terms: string[];
  kind: TaskKind;
  prompt?: string;
}

export interface SessionRow {
  id: string;
  title?: string;
  project: string;
  start: string;
  tasks: number;
  usage: Usage;
  eq: number;
  usd: number | null;
  /** "reported" = Claude Code's own cost for the session; "estimated" = from its tokens. */
  costSource: 'reported' | 'estimated';
}

export interface HistoryFilter {
  project?: string;
  since?: string;
}

function filterSessions(sessions: Session[], f: HistoryFilter): Session[] {
  const proj = f.project?.toLowerCase();
  return sessions.filter(
    (s) => (!proj || s.project.toLowerCase().includes(proj)) && (!f.since || s.end >= f.since),
  );
}

function cacheWriteShare(u: Usage, eq: number): number {
  return eq > 0 ? (u.cacheWrite5m * WEIGHTS.cacheWrite5m + u.cacheWrite1h * WEIGHTS.cacheWrite1h) / eq : 0;
}

/** One row per task that made at least one API call. */
function taskRows(sessions: Session[], prices: Prices): TaskRow[] {
  const rows: TaskRow[] = [];
  for (const s of sessions) {
    let first = true;
    for (const t of s.tasks) {
      if (t.turns === 0 && t.subagents === 0) continue;
      const usage = totalUsage(t.usageByModel);
      const eq = taskEquivalent(t);
      rows.push({
        sessionId: s.id,
        sessionTitle: s.title,
        project: s.project,
        start: t.start,
        end: t.end,
        estimate: t.estimate === true,
        usage,
        eq,
        usd: taskCost(t, prices),
        turns: t.turns,
        subagents: t.subagents,
        subagentEq: equivalent(t.subagentUsage),
        initialContext: t.initialContext,
        initialUsage: t.initialUsage,
        opensSession: first,
        cacheWriteShare: cacheWriteShare(usage, eq),
        terms: t.terms,
        kind: t.kind,
        prompt: t.prompt,
      });
      first = false;
    }
  }
  return rows;
}

/** Session totals come from every response; tasks only break them down. */
function sessionRows(sessions: Session[], tasks: TaskRow[], prices: Prices, live: Map<string, number>): SessionRow[] {
  const count = new Map<string, number>();
  for (const t of tasks) count.set(t.sessionId, (count.get(t.sessionId) ?? 0) + 1);
  return sessions
    .filter((s) => count.has(s.id))
    .map((s) => {
      const usage = totalUsage(s.usageByModel);
      const cost = sessionCost(s, prices, live.get(s.id));
      const row = { id: s.id, title: s.title, project: s.project, start: s.start, tasks: count.get(s.id)!, usage };
      return { ...row, eq: sessionEquivalent(s), usd: cost.usd, costSource: cost.source };
    });
}

export interface HistoryData {
  sessions: SessionRow[];
  tasks: TaskRow[];
  prices: Prices;
}

/** Prices are learned from ALL sessions, then the filter is applied. */
export function buildHistory(all: Session[], filter: HistoryFilter, live = new Map<string, number>()): HistoryData {
  const prices = learnPrices(all);
  const selected = filterSessions(all, filter);
  const tasks = taskRows(selected, prices);
  return { sessions: sessionRows(selected, tasks, prices, live), tasks, prices };
}

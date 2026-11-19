import { percentile } from './cost.js';
import type { TaskRow } from './history.js';

export interface Pattern {
  id: 'cache-writes' | 'many-turns' | 'subagents' | 'big-context';
  label: string;
  tasks: number;
  /** Share of all equivalent tokens spent in matching tasks (subagents: inside subagents). */
  share: number;
  tip: string;
}

const BIG_CONTEXT = 100_000;

function sum(rows: TaskRow[], f: (r: TaskRow) => number): number {
  return rows.reduce((a, r) => a + f(r), 0);
}

/** The most expensive tasks first. */
export function topTasks(rows: TaskRow[], n: number): TaskRow[] {
  return [...rows].sort((a, b) => b.eq - a.eq).slice(0, n);
}

/** Usage patterns that explain where the spend goes, largest share first. */
export function patterns(rows: TaskRow[]): Pattern[] {
  const total = sum(rows, (r) => r.eq);
  if (total === 0) return [];
  const turnLimit = Math.max(30, percentile(rows.map((r) => r.turns), 0.9));
  const share = (m: TaskRow[]) => sum(m, (r) => r.eq) / total;
  const cache = rows.filter((r) => r.cacheWriteShare > 0.4);
  const turns = rows.filter((r) => r.turns >= turnLimit);
  const subs = rows.filter((r) => r.subagents > 0);
  const big = rows.filter((r) => r.initialContext >= BIG_CONTEXT);
  const out: Pattern[] = [
    {
      id: 'cache-writes',
      label: 'Cache-write heavy (>40% of the task spent re-writing the prompt cache)',
      tasks: cache.length,
      share: share(cache),
      tip: 'Avoid long pauses mid-task (the cache expires) and avoid switching model or editing CLAUDE.md mid-session.',
    },
    {
      id: 'many-turns',
      label: `Long loops (${Math.round(turnLimit)}+ turns)`,
      tasks: turns.length,
      share: share(turns),
      tip: 'Split the task into steps with a clear stop, or give the exact files and the acceptance test up front.',
    },
    {
      id: 'subagents',
      label: 'Spent inside subagents',
      tasks: subs.length,
      share: sum(subs, (r) => r.subagentEq) / total,
      tip: 'Use subagents for broad searches only; give them a narrow brief and a cheaper model.',
    },
    {
      id: 'big-context',
      label: `Started with ${BIG_CONTEXT / 1000}k+ tokens already in context (long sessions, big CLAUDE.md or MCP tools)`,
      tasks: big.length,
      share: share(big),
      tip: 'Use /clear or a fresh session between unrelated tasks, /compact long ones, and trim always-loaded instructions and MCP servers.',
    },
  ];
  return out.filter((p) => p.tasks > 0).sort((a, b) => b.share - a.share);
}

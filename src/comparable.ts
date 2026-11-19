import type { TaskRow } from './history.js';

/** A session active this recently in the project is taken as the one running now. */
export const ACTIVE_MS = 10 * 60 * 1000;

export interface Exclude {
  /** Project (cwd) of the estimate. */
  project: string;
  /** Current session id, when known (CLAUDE_CODE_SESSION_ID, hook input or --session). */
  session?: string;
  now?: Date;
}

/** The session running now: the given id, else the latest one in the project if it was active in the last 10 minutes. */
export function currentSession(rows: TaskRow[], x: Exclude): string | undefined {
  if (x.session) return x.session;
  const now = (x.now ?? new Date()).getTime();
  let latest: TaskRow | undefined;
  for (const r of rows) {
    if (r.project.toLowerCase() !== x.project.toLowerCase()) continue;
    if (!latest || r.end > latest.end) latest = r;
  }
  return latest && now - Date.parse(latest.end) < ACTIVE_MS ? latest.sessionId : undefined;
}

/**
 * Past tasks an estimate may compare with: never `/estimate` requests (they echo the
 * description and cost almost nothing) and never the session running now (its last task is
 * unfinished, and it holds the estimate request itself).
 */
export function comparableRows(rows: TaskRow[], x: Exclude): TaskRow[] {
  const current = currentSession(rows, x);
  return rows.filter((r) => !r.estimate && r.sessionId !== current);
}

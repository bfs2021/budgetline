import type { Calibration } from './calibration.js';
import { pct, projectName, table, tokensExact, truncate } from './format.js';
import { money } from './session-line.js';
import type { HistoryData, SessionRow, TaskRow } from './history.js';
import { patterns, topTasks } from './insights.js';

export interface RenderOptions {
  limit: number;
  showPrompts: boolean;
  /** Session titles in --json output (always shown in the terminal table). */
  showTitles?: boolean;
  /** "Accuracy so far" line for budgetline's own estimates. */
  accuracy?: string;
  /** Usage-limit data seen (Pro/Max plan): the $ is API-equivalent value, not a bill. */
  plan?: boolean;
  calibration?: Calibration | null;
}

const moneyHead = (o: RenderOptions) => (o.plan ? 'API value' : 'Cost');

/** Share of the 5-hour limit, when calibrated: first on a plan, since that is what limits the user. */
function limitCell(r: TaskRow, o: RenderOptions): string[] {
  if (!o.calibration) return [];
  return [r.usd === null ? 'n/a' : `${Math.round(r.usd * o.calibration.fivePerUsd)}%`];
}

function label(id: string, title?: string): string {
  const short = id.slice(0, 8);
  return title ? `${short} ${truncate(title, 34)}` : short;
}

function sessionTable(rows: SessionRow[], opts: RenderOptions): string {
  const limit = opts.limit;
  const recent = [...rows].sort((a, b) => (a.start < b.start ? 1 : -1)).slice(0, limit);
  return table(
    ['Session', 'Project', 'Date', 'Tasks', 'Input', 'Cache W', 'Cache R', 'Output', 'Equiv', moneyHead(opts)],
    recent.map((r) => [
      label(r.id, r.title),
      truncate(projectName(r.project), 18),
      r.start.slice(0, 10),
      String(r.tasks),
      tokensExact(r.usage.input),
      tokensExact(r.usage.cacheWrite5m + r.usage.cacheWrite1h),
      tokensExact(r.usage.cacheRead),
      tokensExact(r.usage.output),
      tokensExact(r.eq),
      money(r.usd, r.costSource === 'estimated'),
    ]),
    3,
  );
}

function topTable(rows: TaskRow[], total: number, opts: RenderOptions): string {
  const top = topTasks(rows, Math.min(opts.limit, 10));
  const t = table(
    ['Task', 'Date', 'Turns', 'Subagents', 'Start ctx', 'Eq tokens', 'Share', ...(opts.calibration ? ['5h limit'] : []), moneyHead(opts)],
    top.map((r) => [
      label(r.sessionId, r.sessionTitle),
      r.start.slice(0, 10),
      String(r.turns),
      String(r.subagents),
      tokensExact(r.initialContext),
      tokensExact(r.eq),
      pct(r.eq / total),
      ...limitCell(r, opts),
      money(r.usd, true),
    ]),
    2,
  );
  if (!opts.showPrompts) return t;
  const prompts = top.map((r, i) => `  ${i + 1}. ${truncate(r.prompt ?? '', 100)}`);
  return `${t}\n\nPrompts (shown because of --show-prompts):\n${prompts.join('\n')}`;
}

function totals(d: HistoryData, opts: RenderOptions): string {
  const eq = d.sessions.reduce((a, r) => a + r.eq, 0);
  const known = d.sessions.filter((r) => r.usd !== null);
  const cost = known.reduce((a, r) => a + (r.usd ?? 0), 0);
  const approx = known.some((r) => r.costSource === 'estimated'); // any estimated $ makes the sum an estimate
  const costNote = known.length < d.sessions.length ? ` (${d.sessions.length - known.length} sessions without a known price)` : '';
  return `${d.sessions.length} sessions, ${d.tasks.length} tasks, ${tokensExact(eq)} equivalent tokens, ${money(cost, approx)}${opts.plan ? ' API-equivalent value' : ''}${costNote}`;
}

export function renderHistory(d: HistoryData, opts: RenderOptions): string {
  if (d.tasks.length === 0) return 'No Claude Code sessions found (looked in <config>/projects). Nothing to summarize yet.';
  const total = d.sessions.reduce((a, r) => a + r.eq, 0);
  const pats = patterns(d.tasks).map(
    (p) => `- ${p.label}: ${p.tasks} tasks, ${pct(p.share)} of spend.\n  Tip: ${p.tip}`,
  );
  return [
    `budgetline history: ${totals(d, opts)}`,
    '',
    sessionTable(d.sessions, opts),
    '',
    "What's expensive: top tasks",
    topTable(d.tasks, total, opts),
    '',
    "What's expensive: patterns",
    pats.length ? pats.join('\n') : '- Nothing stands out.',
    '',
    ...(opts.accuracy ? ['How accurate budgetline estimates have been', opts.accuracy, ''] : []),
    'Equivalent tokens (Equiv) weight each token by its price relative to input (cache read 0.1, cache write 1.25-2, output 5); the guard and status line use the same unit.',
    "Session $ is what Claude Code reported for it (same figure and rounding as the status line); '~$' marks an estimate from its tokens (no cost recorded). Task $ is always an estimate (~).",
    opts.plan
      ? 'On your plan the $ is API-equivalent value (what the API would charge); what limits you is the %. Prompts are hidden unless you pass --show-prompts.'
      : 'Costs use the real per-session cost Claude Code records; prompts are hidden unless you pass --show-prompts.',
  ].join('\n');
}

/** JSON view: metrics only; prompt text is present only when it was loaded (--show-prompts). */
export function historyJson(d: HistoryData, opts: RenderOptions): string {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- terms are internal
  const strip = ({ prompt, terms, sessionTitle, ...r }: TaskRow) => ({
    ...r,
    ...(opts.showTitles ? { sessionTitle } : {}),
    ...(opts.showPrompts ? { prompt } : {}),
  });
  const session = ({ title, ...r }: SessionRow) => (opts.showTitles ? { ...r, title } : r);
  return JSON.stringify(
    { accuracy: opts.accuracy, usdMeaning: opts.plan ? 'api-equivalent-value' : 'cost', sessions: d.sessions.map(session), topTasks: topTasks(d.tasks, opts.limit).map(strip), patterns: patterns(d.tasks) },
    null,
    2,
  );
}

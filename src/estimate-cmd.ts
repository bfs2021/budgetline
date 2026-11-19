import { money } from './session-line.js';
import { join, resolve } from 'node:path';
import type { Parsed } from './args.js';
import { str } from './args.js';
import { baseCost, baseEq, type BaseCost } from './base-cost.js';
import { accuracyLine, evaluate, logEstimate, measuredBias, readLog, type Bias, type EstimateLog } from './accuracy.js';
import { comparableRows } from './comparable.js';
import { readBilling, type Calibration } from './calibration.js';
import { load } from './data.js';
import { basisPrice, estimateFromHistory, shift, WIDE_RATIO, type Estimate, type Range } from './estimate.js';
import { tokens, truncate, usd } from './format.js';
import { buildHistory, type TaskRow } from './history.js';
import { dataDir } from './paths.js';
import { citedCost, repoContext, type RepoContext } from './repo-context.js';
import { suggestions } from './suggest.js';
import type { Session } from './transcripts/types.js';

export interface EstimateResult {
  est: Estimate;
  ctx: RepoContext;
  eq: Range;
  usd: Range | null;
  limit5h: Range | null;
  calibration: Calibration | null;
  /** Usage-limit data seen (Pro/Max plan): the $ is API-equivalent value, not a bill. */
  plan: boolean;
  /** Fixed context per call in this project (system prompt, tools, instructions), if measurable. */
  base: BaseCost | null;
  /** The estimate minus the fixed context of its typical calls: what depends on the task. */
  taskEq: Range | null;
  /** USD per equivalent token in the basis, for pricing the base cost. */
  price: number | null;
  tips: string[];
  /** "Accuracy so far" line, filled by the command. */
  accuracy?: string;
  /** Measured bias applied to eq, usd and limit5h (null: not enough checked estimates). */
  bias: Bias | null;
  /** Typical equivalent tokens before the bias correction. */
  rawTypical: number;
}

export interface EstimateOptions {
  /** Session running now: never compared with (CLAUDE_CODE_SESSION_ID, hook input, --session). */
  session?: string;
  /** Past estimates, to measure and correct the bias. */
  log?: EstimateLog[];
  now?: Date;
}

function scale(r: Range, k: number): Range {
  return { low: r.low * k, typical: r.typical * k, high: r.high * k };
}

/** Full estimate: history-based range + cited files + optional limit calibration. */
export function runEstimate(sessions: Session[], description: string, cwd: string, calibration: Calibration | null, plan = calibration !== null, opts: EstimateOptions = {}): EstimateResult | null {
  return estimateFromRows(buildHistory(sessions, {}).tasks, description, cwd, calibration, plan, opts);
}

function estimateFromRows(rows: TaskRow[], description: string, cwd: string, calibration: Calibration | null, plan: boolean, opts: EstimateOptions): EstimateResult | null {
  const est = estimateFromHistory(comparableRows(rows, { project: cwd, session: opts.session, now: opts.now }), description, cwd);
  if (!est) return null;
  const ctx = repoContext(cwd, description);
  const extra = citedCost(ctx.citedTokens, est.medianTurns);
  const price = basisPrice(est.basis.rows);
  const bias = opts.log ? measuredBias(opts.log, rows) : null;
  const k = bias?.factor ?? 1;
  const raw = shift(est.eq, extra);
  const eq = scale(raw, k);
  const usdRange = est.usd && price !== null ? scale(shift(est.usd, extra * price), k) : null;
  const limit5h = usdRange && calibration ? scale(usdRange, calibration.fivePerUsd) : null;
  const base = baseCost(rows, cwd);
  const taskEq = base ? minus(eq, baseInTask(base, est)) : null;
  const tips = suggestions({ description, est, ctx, base });
  return { est, ctx, eq, usd: usdRange, limit5h, calibration, plan, base, taskEq, price, tips, bias, rawTypical: raw.typical };
}

/** Expected fixed-context part of a task like the basis: its calls re-read it, fresh sessions also write it. */
function baseInTask(b: BaseCost, est: Estimate): number {
  const rows = est.basis.rows;
  const fresh = rows.length ? rows.filter((r) => r.opensSession).length / rows.length : 0;
  return baseEq(b, est.medianTurns, false) + fresh * (b.startEq - b.perCallEq);
}

function minus(r: Range, by: number): Range {
  return { low: Math.max(0, r.low - by), typical: Math.max(0, r.typical - by), high: Math.max(0, r.high - by) };
}

function fmtRange(r: Range, f: (n: number) => string): string {
  return `${f(r.typical)} typical (range ${f(r.low)} – ${f(r.high)})`;
}

function pctFmt(n: number): string {
  return n < 1 ? '<1%' : `${Math.round(n)}%`;
}

function basisLine(r: EstimateResult): string {
  const b = r.est.basis;
  if (b.kind === 'similar') {
    return `Based on ${b.rows.length} similar past ${r.est.taskKind === 'question' ? 'questions' : 'tasks'} (${b.sameProject} in this project, average similarity ${b.avgSimilarity.toFixed(2)}).`;
  }
  const what = r.est.taskKind === 'question' ? 'questions' : 'tasks';
  return `Not enough similar past ${what}: this is the spread of all your past ${what} (${b.rows.length}${b.sameProject ? ' in this project' : ''}), not a task-specific estimate.`;
}

function closestLines(r: EstimateResult): string[] {
  const c = r.est.basis.closest;
  if (!c.length) return [];
  const item = (t: (typeof c)[number]) => `"${truncate(t.sessionTitle ?? t.sessionId.slice(0, 8), 40)}" (${t.usd === null ? tokens(t.eq) : money(t.usd, true)})`;
  return [`Closest: ${c.map(item).join(', ')}. If these look unrelated, ignore the estimate.`];
}

function biasLines(r: EstimateResult): string[] {
  if (!r.bias) return [];
  const dir = r.bias.factor >= 1 ? 'low' : 'high';
  return [
    `Corrected ×${r.bias.factor.toFixed(1)} for measured bias: your last ${r.bias.n} checked estimates came out ${dir} (median actual/estimate). Uncorrected typical: ${tokens(r.rawTypical)}.`,
  ];
}

function warnings(r: EstimateResult): string[] {
  const out: string[] = [];
  if (r.est.fewData) out.push('LOW CONFIDENCE: few comparable tasks. Treat the numbers as a rough prior.');
  if (r.est.wide) out.push(`WIDE RANGE: the high end is more than ${WIDE_RATIO}x the low end. Your similar tasks vary a lot, so the typical value is a guess.`);
  return out;
}

function limitLines(r: EstimateResult): string[] {
  if (r.limit5h) {
    return [`5-hour limit: ~${pctFmt(r.limit5h.typical)} typical (range ${pctFmt(r.limit5h.low)} – ${pctFmt(r.limit5h.high)}), from ${r.calibration!.pairs} status line samples. Parallel sessions make this less accurate.`];
  }
  if (r.plan) return ['Usage-limit %: not calibrated yet (needs ~10 status line samples and $1 of usage).'];
  return ['Usage-limit %: none seen. On a Pro/Max plan, run `budgetline statusline install` to learn it; the $ is then API-equivalent value, not a bill.'];
}

function moneyLine(r: EstimateResult): string {
  const label = r.plan ? 'API-equivalent value' : 'Cost';
  return r.usd ? `${label}: ${fmtRange(r.usd, (n) => usd(n, true))}` : `${label}: n/a (no recorded cost for these models yet)`;
}

/** Plan users are limited by the %, so it goes first; API users pay the $, so it does. */
function headline(r: EstimateResult): string[] {
  return r.plan ? [...limitLines(r), moneyLine(r)] : [moneyLine(r), ...limitLines(r)];
}

function priced(eq: number, price: number | null): string {
  if (price === null) return tokens(eq);
  const d = eq * price;
  return `${tokens(eq)} (~$${d.toFixed(d < 0.1 ? 3 : 2)})`;
}

function baseLines(r: EstimateResult): string[] {
  const b = r.base;
  if (!b || !r.taskEq) return [];
  const where = b.sameProject ? 'in this project' : `(all projects: fewer than 3 sessions here)`;
  return [
    `Base cost per message ${where}: ~${tokens(b.tokens)} tokens of fixed context (system prompt, tools, CLAUDE.md/rules, plugins, skills, memory). ` +
      `A session's first message writes it to the cache: ~${priced(b.startEq, r.price)} equivalent; each later API call re-reads it: ~${priced(b.perCallEq, r.price)}.`,
    `Task cost (beyond the fixed context): ${fmtRange(r.taskEq, tokens)} equivalent tokens.`,
  ];
}

function contextLine(r: EstimateResult): string {
  const base = r.ctx.baseTokens ? `instruction files ~${tokens(r.ctx.baseTokens)} tokens per turn` : 'no CLAUDE.md or rules found';
  const cited = r.ctx.cited.length
    ? `cited files ~${tokens(r.ctx.citedTokens)} tokens (${r.ctx.cited.map((f) => f.path).join(', ')})`
    : 'no cited files found';
  return `Repo context: ${base}; ${cited}.`;
}

export function renderEstimate(r: EstimateResult): string {
  const lines = [
    'budgetline estimate (local, approximate)',
    '',
    ...headline(r),
    `Tokens: ${fmtRange(r.eq, tokens)} equivalent (priced like input tokens)`,
    ...biasLines(r),
    '',
    basisLine(r),
    ...closestLines(r),
    ...warnings(r),
    contextLine(r),
    ...baseLines(r),
    'Session: this assumes a typical session. In a long session every turn re-reads the whole conversation, so it costs more; for a quick question, a fresh session is cheaper.',
    ...(r.accuracy ? [r.accuracy] : []),
    '',
    'How to save:',
    ...(r.tips.length ? r.tips.map((t) => `- ${t}`) : ['- Nothing obvious: the task looks reasonably scoped.']),
  ];
  return lines.join('\n');
}

export function estimateJson(r: EstimateResult): string {
  const { est, ...rest } = r;
  const basis = { kind: est.basis.kind, tasks: est.basis.rows.length, sameProject: est.basis.sameProject, avgSimilarity: est.basis.avgSimilarity };
  const usdMeaning = r.plan ? 'api-equivalent-value' : 'cost';
  return JSON.stringify({ ...rest, usdMeaning, basis, wide: est.wide, lowConfidence: est.fewData, biasFactor: r.bias?.factor ?? 1 }, null, 2);
}

export function estimateCommand(p: Parsed): string {
  const description = p.positional.join(' ').trim();
  if (!description) throw new Error('describe the task, e.g. budgetline estimate "add a login page"');
  const cwd = resolve(str(p, 'cwd') ?? process.cwd());
  const { calibration, plan } = readBilling(join(dataDir(), 'limits.jsonl'));
  const rows = buildHistory(load(p), {}).tasks;
  const logFile = join(dataDir(), 'estimates.jsonl');
  const log = readLog(logFile);
  const session = str(p, 'session') ?? process.env.CLAUDE_CODE_SESSION_ID;
  const r = estimateFromRows(rows, description, cwd, calibration, plan, { session, log });
  if (!r) return 'No Claude Code history found yet: nothing to estimate from. Use Claude Code for a few tasks first.';
  r.accuracy = accuracyLine(evaluate(log, rows));
  logEstimate(logFile, cwd, r.eq, new Date(), r.rawTypical);
  return p.flags.json ? estimateJson(r) : renderEstimate(r);
}

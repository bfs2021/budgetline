import { tokensExact, usd } from './format.js';

/**
 * The figures of one session, as every view shows them. The status line and
 * `budgetline session` both render them with sessionLine(), so the same session
 * gives the same text in both.
 */
export interface SessionFigures {
  /** Usage-limit % (plans only). */
  five?: number;
  seven?: number;
  /** Session cost: what Claude Code reported, unless `approx` (estimated from tokens). */
  usd: number | null;
  approx?: boolean;
  /** On a plan the $ is API-equivalent value, not a bill. */
  plan: boolean;
  /** Equivalent tokens of every response in the session (main + subagents). */
  eq: number | null;
  /** Context window used, % (shown only with the guard on). */
  ctx?: number;
  guard?: { budget: number; warnAt: number; ctxWarn: number };
}

/** "$1.25" as reported, or "~$1.2" when estimated (2 significant figures): "~" always marks an estimate. */
export function money(n: number | null, approx = false): string {
  return n !== null && approx ? `~${usd(n, true)}` : usd(n);
}

function costPart(f: SessionFigures): string | null {
  if (f.usd === null) return null;
  return `${money(f.usd, f.approx)}${f.plan ? ' API value' : ''} this session`;
}

function eqPart(f: SessionFigures): string | null {
  if (f.eq === null || f.eq <= 0) return null;
  const g = f.guard;
  return `Equiv ${tokensExact(f.eq)}${g ? `/${tokensExact(g.budget)}${f.eq >= g.warnAt ? ' ⚠' : ''}` : ''}`;
}

function ctxPart(f: SessionFigures): string | null {
  if (!f.guard || typeof f.ctx !== 'number') return null;
  return `ctx ${Math.round(f.ctx)}%${f.ctx >= f.guard.ctxWarn ? ' ⚠' : ''}`;
}

const pctPart = (label: string, v?: number) => (typeof v === 'number' ? `${label}: ${Math.round(v)}%` : null);

/** "5h: 23% · 7d: 41% · $1.25 API value this session · Equiv 1.2M/2M · ctx 40%" */
export function sessionLine(f: SessionFigures): string {
  const parts = [pctPart('5h', f.five), pctPart('7d', f.seven), costPart(f), eqPart(f), ctxPart(f)];
  const shown = parts.filter((x): x is string => x !== null);
  return shown.length ? shown.join(' · ') : 'budgetline';
}

import type { Parsed } from './args.js';
import { positive, str, warnArg } from './args.js';
import { percentile } from './cost.js';
import { sessionEq } from './transcripts/incremental.js';
import { load } from './data.js';
import { round2, tokens, tokensExact } from './format.js';
import { buildHistory } from './history.js';
import { readConfig, warnTokens, writeConfig, type Config } from './config.js';
import { advance, readState, writeState, type SessionState } from './guard-state.js';
import { dataDir } from './paths.js';

const DEFAULT_WINDOW = 200_000;
/** Long-context models: a request bigger than the assumed window proves the window is this one. */
const LARGE_WINDOW = 1_000_000;

/** Reported by the status line, else configured, else 200k; never smaller than a request already seen. */
export function windowSize(c: Config, s: SessionState): number {
  const w = s.window || c.contextWindowTokens || DEFAULT_WINDOW;
  return s.context > w ? Math.max(LARGE_WINDOW, s.context) : w;
}

/** The config with this session's own budget applied (`guard session`), if it has one. */
export function sessionConfig(c: Config, s: Pick<SessionState, 'budget' | 'warn'>): Config {
  if (!s.budget) return c;
  const share = c.sessionBudgetTokens > 0 ? `${Math.round((warnTokens(c) / c.sessionBudgetTokens) * 100)}%` : '80%';
  return { ...c, sessionBudgetTokens: s.budget, sessionWarnTokens: s.warn ?? share };
}

interface Notice {
  context: string;
  user: string;
}

function budgetNotice(c: Config, s: SessionState): Notice | null {
  const used = `Equiv ${tokensExact(s.eq)}/${tokensExact(c.sessionBudgetTokens)}`;
  if (s.eq >= c.sessionBudgetTokens) {
    return {
      context: `budgetline: session budget exceeded (${used}, equivalent tokens). Do not start new work. Finish the current step without leaving anything half-done, then tell the user, summarize the current state and the next steps, and propose continuing in a fresh session with a ready-to-paste continuation prompt.`,
      user: `budgetline: session budget exceeded (${used})`,
    };
  }
  if (s.eq >= warnTokens(c) && !s.warned.budget) {
    s.warned.budget = true;
    return { context: `budgetline: session at ${used}. Mention this to the user in one line.`, user: `budgetline: session at ${used}` };
  }
  return null;
}

function contextNotice(c: Config, s: SessionState): Notice | null {
  const pct = Math.round((s.context / windowSize(c, s)) * 100);
  if (pct < c.contextWarnPercent) {
    s.warned.context = false; // e.g. after /compact: warn again if it fills up again
    return null;
  }
  if (s.warned.context) return null;
  s.warned.context = true;
  const msg = `budgetline: context at ${pct}% of window; answer quality may degrade — consider wrapping up and starting a fresh session`;
  return { context: `${msg}. Tell the user about this now, in one line.`, user: msg };
}

/**
 * Hook body for UserPromptSubmit and PostToolBatch. Returns the hook's stdout: empty unless
 * a threshold is crossed. Never blocks; any error means "say nothing".
 */
export function guardOutput(input: string, dir: string, c: Config = readConfig(dir)): string {
  if (!c.guardEnabled) return '';
  try {
    const { session_id: session, transcript_path: transcript, hook_event_name: event } = JSON.parse(input);
    if (!session || !transcript || !event) return '';
    const s = advance(readState(dir, session), transcript);
    s.eq = sessionEq(transcript, dir) ?? s.eq; // same Equiv as the status line and history (main + subagents)
    const notices = [budgetNotice(sessionConfig(c, s), s), contextNotice(c, s)].filter((n): n is Notice => n !== null);
    writeState(dir, session, s);
    if (!notices.length) return '';
    return JSON.stringify({
      hookSpecificOutput: { hookEventName: event, additionalContext: notices.map((n) => n.context).join('\n') },
      systemMessage: notices.map((n) => n.user).join(' · '),
    });
  } catch {
    return '';
  }
}

/** Budget and context thresholds for the session line, when the guard is on. */
export function guardFigure(dir: string, session?: string): { budget: number; warnAt: number; ctxWarn: number } | undefined {
  const g = readConfig(dir);
  const c = session ? sessionConfig(g, readState(dir, session)) : g;
  return c.guardEnabled ? { budget: c.sessionBudgetTokens, warnAt: warnTokens(c), ctxWarn: c.contextWarnPercent } : undefined;
}

const FALLBACK_BUDGET = 2_000_000;
const RECENT = 30;

/** Default budget: 75th percentile of the last 30 sessions' equivalent tokens (2M with fewer than 5). */
export function proposeBudget(sessions: { start: string; eq: number }[]): { budget: number; note: string } {
  const recent = sessions.filter((s) => s.eq > 0).sort((a, b) => (a.start < b.start ? 1 : -1)).slice(0, RECENT);
  if (recent.length < 5) return { budget: FALLBACK_BUDGET, note: 'not enough history yet, using the 2M fallback' };
  const budget = round2(percentile(recent.map((s) => s.eq), 0.75));
  return { budget, note: `based on your last ${recent.length} sessions: 75% of them used less than ${tokens(budget)} equivalent tokens` };
}

function enable(p: Parsed, dir: string): string {
  const patch: Record<string, unknown> = { guardEnabled: true };
  const budget = positive(p, 'budget');
  const warn = warnArg(p);
  const ctx = positive(p, 'context');
  if (ctx !== undefined && ctx > 100) throw new Error('--context is a percentage of the window: 1-100');
  const win = str(p, 'window') === 'auto' ? undefined : positive(p, 'window');
  let note = '';
  if (budget) patch.sessionBudgetTokens = budget;
  else {
    const prop = proposeBudget(buildHistory(load(p), {}).sessions);
    patch.sessionBudgetTokens = prop.budget;
    note = `Budget ${tokens(prop.budget)}: ${prop.note}. Override with --budget.
`;
  }
  patch.sessionWarnTokens = warn ?? '80%';
  if (ctx) patch.contextWarnPercent = ctx;
  if (win) patch.contextWindowTokens = win;
  if (str(p, 'window') === 'auto') patch.contextWindowTokens = undefined;
  writeConfig(dir, patch);
  return `${note}Guard enabled. ${status(dir)}\nDisable with: budgetline guard disable`;
}

function status(dir: string): string {
  const c = readConfig(dir);
  if (!c.guardEnabled) return 'Guard: disabled (default).';
  const win = tokens(c.contextWindowTokens || DEFAULT_WINDOW);
  return `Guard: enabled. Session budget ${tokens(c.sessionBudgetTokens)} equivalent tokens, warning at ${tokens(warnTokens(c))}; context warning at ${c.contextWarnPercent}% of the window (the size the status line reports; else ${win}).`;
}

export function guardCommand(p: Parsed): string {
  const sub = p.positional[0];
  const dir = dataDir();
  if (sub === 'enable') return enable(p, dir);
  if (sub === 'disable') {
    writeConfig(dir, { guardEnabled: false });
    return 'Guard disabled. Your settings are kept in config.json for next time.';
  }
  if (sub === 'status') return status(dir);
  if (sub === 'session') return sessionBudget(p, dir);
  throw new Error('usage: budgetline guard enable [--budget N] [--warn N|80%] [--context P] [--window N] | disable | status | session --budget N [--warn N|80%] [--session ID] | session --clear');
}

/** `guard session`: a budget for one session only (default: the one running this command). */
export function sessionBudget(p: Parsed, dir: string, env = process.env): string {
  const session = str(p, 'session') ?? env.CLAUDE_CODE_SESSION_ID;
  if (!session) throw new Error('no session: pass --session <id> (inside Claude Code the current one is used)');
  const s = readState(dir, session);
  if (p.flags.clear === true) {
    delete s.budget;
    delete s.warn;
  } else {
    const budget = positive(p, 'budget');
    if (!budget) throw new Error('usage: budgetline guard session --budget N [--warn N|80%] [--session ID] | --clear');
    s.budget = budget;
    s.warn = warnArg(p);
    s.warned.budget = false;
  }
  writeState(dir, session, s);
  const g = readConfig(dir);
  const c = sessionConfig(g, s);
  const what = s.budget ? `budget ${tokens(c.sessionBudgetTokens)}, warning at ${tokens(warnTokens(c))}` : `back to the global budget (${tokens(g.sessionBudgetTokens)})`;
  const off = g.guardEnabled ? '' : '\nThe guard is disabled: turn it on with budgetline guard enable.';
  return `Session ${session.slice(0, 8)}: ${what}.${off}`;
}

/** Remember the real window size the status line reports, for the context warning. */
export function recordWindow(dir: string, session: string, size: unknown): void {
  if (!session || !(Number(size) > 0) || !readConfig(dir).guardEnabled) return;
  const s = readState(dir, session);
  if (s.window === Number(size)) return;
  s.window = Number(size);
  writeState(dir, session, s);
}

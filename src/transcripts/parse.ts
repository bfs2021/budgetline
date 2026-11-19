import { parseJsonl } from '../jsonl.js';
import { isEstimateRequest, taskKind, terms } from '../text.js';
import { addUsage, emptyUsage, promptTokens, type Session, type Task, type Usage } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- transcript lines are untyped JSON */
type Line = Record<string, any>;

export interface ParseOptions {
  /** Keep the raw prompt text on each task (only for --show-prompts). */
  keepPrompts?: boolean;
}


/** The text of a real user request, or null for meta, tool results and local output. */
export function promptText(o: Line): string | null {
  if (o.type !== 'user' || o.isMeta || o.isSidechain) return null;
  const c = o.message?.content;
  if (typeof c === 'string') return fromString(c);
  if (!Array.isArray(c) || c.some((b: Line) => b?.type === 'tool_result')) return null;
  const text = c.filter((b: Line) => b?.type === 'text').map((b: Line) => String(b.text ?? '')).join('\n');
  return text ? fromString(text) : null;
}

function fromString(c: string): string | null {
  const cmd = /<command-name>([^<]*)<\/command-name>/.exec(c);
  if (cmd) {
    const args = /<command-args>([^<]*)<\/command-args>/.exec(c);
    return `${cmd[1]} ${args?.[1] ?? ''}`.trim();
  }
  return SYSTEM_TAG.test(c.trimStart()) ? null : c;
}

/** Text Claude Code injects as a user line: not a request. A pasted block (<pasted_content>) is one. */
const SYSTEM_TAG = /^<(command-|local-command-|system-reminder|task-notification|bash-|user-memory-input)/;

export function toUsage(u: Line): Usage {
  const cc = u.cache_creation;
  const total = Number(u.cache_creation_input_tokens ?? 0);
  const w1h = Number(cc?.ephemeral_1h_input_tokens ?? 0);
  return {
    input: Number(u.input_tokens ?? 0),
    cacheWrite1h: w1h,
    // no breakdown, or only the 1h part: the rest of the total is 5-minute writes
    cacheWrite5m: cc?.ephemeral_5m_input_tokens !== undefined ? Number(cc.ephemeral_5m_input_tokens) : Math.max(0, total - w1h),
    cacheRead: Number(u.cache_read_input_tokens ?? 0),
    output: Number(u.output_tokens ?? 0),
  };
}

/** One API response: the same key on every line (one per content block) it was written as. */
export const responseKey = (o: Line): string => `${o.message?.id ?? o.uuid}|${o.requestId ?? ''}`;

/** A deduplicated assistant response: [model, usage, timestamp], or null if already seen. */
export function response(o: Line, seen: Set<string>): [string, Usage, string] | null {
  if (o.type !== 'assistant' || !o.message?.usage) return null;
  const model = String(o.message.model ?? 'unknown');
  if (model === '<synthetic>') return null;
  const key = responseKey(o);
  if (seen.has(key)) return null;
  seen.add(key);
  return [model, toUsage(o.message.usage), String(o.timestamp ?? '')];
}

function newTask(index: number, ts: string, text: string, opts: ParseOptions): Task {
  return {
    index,
    start: ts,
    end: ts,
    terms: terms(text),
    kind: taskKind(text),
    ...(isEstimateRequest(text) ? { estimate: true } : {}),
    prompt: opts.keepPrompts ? text : undefined,
    usageByModel: {},
    turns: 0,
    subagents: 0,
    subagentUsage: emptyUsage(),
    initialContext: 0,
  };
}

/** The task for responses that arrive before any detected request, created on demand. */
function untitled(s: Session, ts: string): Task {
  if (s.tasks[0]?.untitled) return s.tasks[0];
  const t = newTask(0, ts, '', {});
  t.untitled = true;
  s.tasks.unshift(t);
  s.tasks.forEach((x, i) => (x.index = i));
  return t;
}

/** Every response counts toward the session total, whatever task it lands in. */
function add(s: Session, task: Task, model: string, u: Usage, ts: string): void {
  addTo(task, model, u, ts);
  addUsage((s.usageByModel[model] ??= emptyUsage()), u);
}

function addTo(task: Task, model: string, u: Usage, ts: string): void {
  const slot = (task.usageByModel[model] ??= emptyUsage());
  addUsage(slot, u);
  if (ts > task.end) task.end = ts;
}

const TITLE_FIELD: Record<string, string> = { 'ai-title': 'aiTitle', 'custom-title': 'customTitle' };

function readMeta(o: Line, s: Session): void {
  s.project ||= typeof o.cwd === 'string' ? o.cwd : '';
  s.id ||= typeof o.sessionId === 'string' ? o.sessionId : '';
  const titleField = TITLE_FIELD[o.type];
  if (titleField && typeof o[titleField] === 'string') s.title = o[titleField];
  if (o.type === 'cost-state' && o.modelUsage) s.reportedCost = reportedCost(o.modelUsage);
}

function reportedCost(modelUsage: Line): Session['reportedCost'] {
  const out: NonNullable<Session['reportedCost']> = {};
  for (const [m, v] of Object.entries<Line>(modelUsage)) out[m] = { costUSD: Number(v.costUSD ?? 0) };
  return out;
}

function readMain(lines: Line[], s: Session, opts: ParseOptions): void {
  const seen = new Set<string>();
  let cur: Task | undefined;
  for (const o of lines) {
    readMeta(o, s);
    const text = promptText(o);
    if (text !== null) {
      cur = newTask(s.tasks.length, String(o.timestamp ?? ''), text, opts);
      s.tasks.push(cur);
      continue;
    }
    const r = response(o, seen);
    if (!r) continue;
    const [model, u, ts] = r;
    cur ??= untitled(s, ts);
    if (cur.turns === 0) {
      cur.initialContext = promptTokens(u);
      cur.initialUsage = { ...u, output: 0 };
    }
    cur.turns++;
    add(s, cur, model, u, ts);
  }
}

/** The task that was running at `ts`: the last one started at or before it. */
function taskAt(tasks: Task[], ts: string): Task | undefined {
  let found: Task | undefined;
  for (const t of tasks) if (t.start <= ts) found = t;
  return found;
}

function readSubagent(lines: Line[], s: Session): void {
  const seen = new Set<string>();
  let counted = false;
  for (const o of lines) {
    const r = response(o, seen);
    if (!r) continue;
    const [model, u, ts] = r;
    const task = taskAt(s.tasks, ts) ?? untitled(s, ts);
    if (!counted) {
      task.subagents++;
      counted = true;
    }
    add(s, task, model, u, ts);
    addUsage(task.subagentUsage, u);
  }
}

/** Parse one session transcript plus its subagent transcripts. Null if it has no tasks. */
export function parseSession(main: string, subagents: string[] = [], opts: ParseOptions = {}): Session | null {
  const s: Session = { id: '', project: '', start: '', end: '', tasks: [], usageByModel: {} };
  readMain(parseJsonl(main), s, opts);
  for (const text of subagents) readSubagent(parseJsonl(text), s);
  if (s.tasks.length === 0) return null;
  s.start = s.tasks.reduce((m, t) => (t.start < m ? t.start : m), s.tasks[0]!.start);
  s.end = s.tasks.reduce((m, t) => (t.end > m ? t.end : m), s.start);
  return s;
}

import { readFileSync, writeFileSync } from 'node:fs';
import { privateDir, readNew } from './fsutil.js';
import { join } from 'node:path';
import { equivalent } from './cost.js';
import { parseJsonl } from './jsonl.js';
import { toUsage } from './transcripts/parse.js';
import { promptTokens } from './transcripts/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- transcript lines are untyped JSON */

/** Per-session progress, so each hook call reads only the new part of the transcript. */
export interface SessionState {
  /** Transcript the offset belongs to: a different one (or a shorter file) starts over. */
  transcript?: string;
  offset: number;
  lastKey: string;
  /** Equivalent tokens spent so far in the main transcript. */
  eq: number;
  /** Prompt size of the latest response: input + cache read + cache write. */
  context: number;
  /** Context window size reported by the status line, if seen. */
  window?: number;
  warned: { budget: boolean; context: boolean };
  /** This session's own budget (`guard session`), overriding config.json. */
  budget?: number;
  /** This session's own warning threshold: tokens or a share of its budget. */
  warn?: number | string;
}

const stateFile = (dir: string, session: string) => join(dir, 'guard', `${session.replace(/[^\w-]/g, '_')}.json`);

export function freshState(): SessionState {
  return { offset: 0, lastKey: '', eq: 0, context: 0, warned: { budget: false, context: false } };
}

export function readState(dir: string, session: string): SessionState {
  try {
    return JSON.parse(readFileSync(stateFile(dir, session), 'utf8'));
  } catch {
    return freshState();
  }
}

export function writeState(dir: string, session: string, s: SessionState): void {
  privateDir(join(dir, 'guard'));
  writeFileSync(stateFile(dir, session), JSON.stringify(s));
}

function applyLine(s: SessionState, o: any): void {
  if (o?.type !== 'assistant' || o.isSidechain || !o.message?.usage || o.message.model === '<synthetic>') return;
  const key = `${o.message.id}|${o.requestId ?? ''}`;
  if (key === s.lastKey) return; // the same response repeated once per content block
  s.lastKey = key;
  const u = toUsage(o.message.usage);
  s.eq += equivalent(u);
  s.context = promptTokens(u);
}

/** Bring the session state up to date with the transcript (incremental, complete lines only). */
export function advance(prev: SessionState, transcript: string): SessionState {
  const own = { budget: prev.budget, warn: prev.warn }; // set by the user: survives a restart from zero
  let s = prev.transcript && prev.transcript !== transcript ? { ...freshState(), ...own } : prev;
  let next = readNew(transcript, s.offset);
  if (next.shrunk) {
    s = { ...freshState(), ...own };
    next = readNew(transcript, 0);
  }
  s.transcript = transcript;
  const { text, end } = next;
  for (const o of parseJsonl(text)) applyLine(s, o);
  s.offset = end;
  return s;
}

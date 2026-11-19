import { readFileSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { equivalent } from '../cost.js';
import { privateDir, readNew, writeAtomic } from '../fsutil.js';
import { parseJsonl } from '../jsonl.js';
import { response } from './parse.js';
import { listJsonl } from './scan.js';

/** How far one transcript file has been read, and what it added up to. */
export interface FileProgress {
  offset: number;
  eq: number;
  /** Latest response keys: a response is written once per content block, close together. */
  recent: string[];
}

/** Response keys kept per file to drop the repeated lines of one response. */
const RECENT = 200;

const fresh = (): FileProgress => ({ offset: 0, eq: 0, recent: [] });

/** Bring one file's progress up to date, reading only the complete lines added since last time. */
export function advanceFile(path: string, prev: FileProgress = fresh()): FileProgress {
  let p = prev;
  let next = readNew(path, p.offset);
  if (next.shrunk) {
    p = fresh();
    next = readNew(path, 0);
  }
  if (next.end === p.offset) return p;
  const seen = new Set(p.recent);
  let eq = p.eq;
  for (const o of parseJsonl(next.text)) {
    const r = response(o, seen);
    if (r) eq += equivalent(r[1]);
  }
  return { offset: next.end, eq, recent: [...seen].slice(-RECENT) };
}

const cacheFile = (dir: string, main: string) => join(dir, 'eq', `${basename(main, '.jsonl').replace(/[^\w-]/g, '_')}.json`);

function readCache(file: string): Record<string, FileProgress> {
  try {
    const c = JSON.parse(readFileSync(file, 'utf8'));
    return c && typeof c === 'object' ? c : {};
  } catch {
    return {};
  }
}

/**
 * Equivalent tokens of a session (main transcript + its subagents), the same total a full
 * parse gives, reading only what was appended since the last call. Progress is kept in
 * <data dir>/eq/<session>.json. Null if the main transcript cannot be read.
 */
export function sessionEq(main: string, dir: string): number | null {
  const file = cacheFile(dir, main);
  const old = readCache(file);
  const files = [main, ...listJsonl(join(dirname(main), basename(main, '.jsonl'), 'subagents'))];
  const next: Record<string, FileProgress> = {};
  let total = 0;
  for (const f of files) {
    try {
      next[f] = advanceFile(f, old[f]);
      total += next[f].eq;
    } catch {
      if (f === main) return null;
    }
  }
  if (files.some((f) => next[f] && next[f] !== old[f])) {
    try {
      writeAtomic(join(privateDir(join(dir, 'eq')), basename(file)), JSON.stringify(next));
    } catch {
      // read-only data dir: correct, just not faster next time
    }
  }
  return total;
}

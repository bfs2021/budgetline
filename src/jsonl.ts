import { existsSync, readFileSync } from 'node:fs';

/* eslint-disable @typescript-eslint/no-explicit-any -- JSONL lines are untyped JSON */

/** Parse JSON Lines; blank, truncated or corrupt lines (and non-objects) are skipped, never fatal. */
export function parseJsonl<T = Record<string, any>>(text: string): T[] {
  const out: T[] = [];
  for (const raw of text.split('\n')) {
    if (!raw.trim()) continue;
    try {
      const o = JSON.parse(raw);
      if (o && typeof o === 'object') out.push(o);
    } catch {
      // skip the line
    }
  }
  return out;
}

/** Read a JSON Lines file; a missing file is an empty list. */
export function readJsonl<T>(file: string): T[] {
  return existsSync(file) ? parseJsonl<T>(readFileSync(file, 'utf8')) : [];
}

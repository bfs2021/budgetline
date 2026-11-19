import { existsSync, readdirSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { WEIGHTS } from './cost.js';

/** Rough tokens for a file of this size (about 4 bytes per token for code and English). */
function tokensOfBytes(bytes: number): number {
  return Math.round(bytes / 4);
}

export interface FileTokens {
  path: string;
  tokens: number;
}

export interface RepoContext {
  /** Instruction files loaded on every turn (CLAUDE.md, .claude/rules). */
  base: FileTokens[];
  baseTokens: number;
  /** Files named in the description that exist. */
  cited: FileTokens[];
  citedTokens: number;
}

function fileTokens(cwd: string, p: string): FileTokens | null {
  try {
    const st = statSync(p);
    return st.isFile() ? { path: (relative(cwd, p) || p).replace(/\\/g, '/'), tokens: tokensOfBytes(st.size) } : null;
  } catch {
    return null;
  }
}

function baseFiles(cwd: string): string[] {
  const out = [join(cwd, 'CLAUDE.md'), join(cwd, '.claude', 'CLAUDE.md'), join(cwd, 'CLAUDE.local.md')];
  const rules = join(cwd, '.claude', 'rules');
  if (existsSync(rules)) {
    for (const f of readdirSync(rules)) if (f.endsWith('.md')) out.push(join(rules, f));
  }
  return out;
}

/** Words of the description that look like paths (contain / \ or a file extension). */
export function citedPaths(description: string): string[] {
  const words = description.match(/[@\w./\\-]+/g) ?? [];
  return [...new Set(words.map((w) => w.replace(/^@/, '').replace(/[.,;:]+$/, '')))].filter(
    (w) => /[/\\]/.test(w) || /\.[a-z0-9]{1,5}$/i.test(w),
  );
}

function sum(files: FileTokens[]): number {
  return files.reduce((a, f) => a + f.tokens, 0);
}

/** Context the task will start with in this repo: instruction files plus cited files. */
export function repoContext(cwd: string, description: string): RepoContext {
  const base = baseFiles(cwd)
    .map((p) => fileTokens(cwd, p))
    .filter((f): f is FileTokens => f !== null);
  const cited = citedFiles(cwd, description);
  return { base, baseTokens: sum(base), cited, citedTokens: sum(cited) };
}

/** Existing files named in the description, each once however it was written (dist/a.js, dist\a.js, ./dist/a.js). */
function citedFiles(cwd: string, description: string): FileTokens[] {
  const seen = new Set<string>();
  const out: FileTokens[] = [];
  for (const p of citedPaths(description)) {
    const abs = resolve(cwd, p);
    const key = process.platform === 'win32' ? abs.toLowerCase() : abs;
    const f = seen.has(key) ? null : fileTokens(cwd, abs);
    if (!f) continue;
    seen.add(key);
    out.push(f);
  }
  return out;
}

/**
 * Extra equivalent tokens for reading the cited files: written once to the 1h cache
 * (weight 2), then re-read from cache on each later turn (weight 0.1).
 * Instruction files are not added: past tasks in this repo already paid for them.
 */
export function citedCost(citedTokens: number, turns: number): number {
  return citedTokens * (WEIGHTS.cacheWrite1h + WEIGHTS.cacheRead * Math.max(0, turns - 1));
}

import { homedir } from 'node:os';
import { join } from 'node:path';
import { cpSync, existsSync, renameSync } from 'node:fs';
import { privateDir } from './fsutil.js';

/** Claude Code config dir: CLAUDE_CONFIG_DIR or ~/.claude. */
export function claudeDir(env: NodeJS.ProcessEnv = process.env): string {
  return env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
}

/** Migration note: the product was called "pre-budget" before 0.2.0 and kept its data here. */
export const LEGACY_NAME = 'pre-budget';

/**
 * Where budgetline keeps its local data (index cache, limits log, settings backup, hook config).
 * One fixed folder (not CLAUDE_PLUGIN_DATA): the CLI, the status line and the hook must share it,
 * and only hooks receive the plugin data variable.
 */
export function dataDir(env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
  if (env.BUDGETLINE_DATA) return privateDir(env.BUDGETLINE_DATA);
  const dir = join(home, '.budgetline');
  migrateLegacy(join(home, `.${LEGACY_NAME}`), dir);
  return privateDir(dir);
}

/** Once: move the old data folder to the new name; if it can't be moved, copy it and leave the old one. */
export function migrateLegacy(legacy: string, dir: string): void {
  if (existsSync(dir) || !existsSync(legacy)) return;
  try {
    renameSync(legacy, dir);
  } catch {
    if (!existsSync(dir)) cpSync(legacy, dir, { recursive: true });
  }
}

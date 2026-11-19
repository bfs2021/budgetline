import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeAtomic } from './fsutil.js';

/**
 * A stable entry point for the status line: <data dir>/bin/budgetline.mjs. A plugin installed
 * from a marketplace lives in cache/<marketplace>/<plugin>/<version>/, which changes on every
 * update (and the old folder is deleted 14 days later), so settings.json must not point there.
 * The launcher finds the current install each time it runs. Plain JS, Node built-ins only,
 * no network, no npx.
 */
export const launcherPath = (data: string) => join(data, 'bin', 'budgetline.mjs');

/** This copy of the CLI (the bundle when run from dist/). */
export function currentCli(): string {
  return fileURLToPath(new URL('./cli.js', import.meta.url));
}

/**
 * Order: the copy that installed the launcher when it is a stable folder (a clone, an npm
 * link); else the newest budgetline entry in Claude Code's installed_plugins.json (under
 * CLAUDE_CODE_PLUGIN_CACHE_DIR, else <CLAUDE_CONFIG_DIR or ~/.claude>/plugins); else the
 * installing copy even if it is a versioned plugin folder; else a clear message.
 */
export function launcherSource(fallbackCli: string): string {
  return `#!/usr/bin/env node
// budgetline launcher, written by \`budgetline setup-statusline --write\`. Do not edit:
// it is rewritten on every install. It finds the current budgetline install so the status
// line keeps working after plugin updates. Local only: it reads two files and never uses the network.
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const FALLBACK = ${JSON.stringify(fallbackCli)};
const env = process.env;
const root = env.CLAUDE_CODE_PLUGIN_CACHE_DIR || join(env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'plugins');
const inCache = (p) => resolve(p).toLowerCase().startsWith(resolve(root, 'cache').toLowerCase() + sep);

function fromRegistry() {
  try {
    const reg = JSON.parse(readFileSync(join(root, 'installed_plugins.json'), 'utf8'));
    const list = Object.entries(reg.plugins || {})
      .filter(([id]) => id.split('@')[0] === 'budgetline')
      .flatMap(([, v]) => (Array.isArray(v) ? v : []))
      .sort((a, b) => String(b.lastUpdated || '').localeCompare(String(a.lastUpdated || '')));
    for (const e of list) {
      const cli = typeof e.installPath === 'string' ? join(e.installPath, 'dist', 'cli.js') : '';
      if (cli && existsSync(cli)) return cli;
    }
  } catch {
    // no registry or unreadable: fall through
  }
  return null;
}

function locate() {
  if (existsSync(FALLBACK) && !inCache(FALLBACK)) return FALLBACK;
  return fromRegistry() || (existsSync(FALLBACK) ? FALLBACK : null);
}

const cli = locate();
if (!cli) {
  process.stdout.write('budgetline: install not found (plugin removed?). Reinstall it, then run: budgetline setup-statusline --write\\n');
} else {
  try {
    const m = await import(pathToFileURL(cli).href);
    process.exitCode = await m.main(process.argv.slice(2));
  } catch (err) {
    process.stdout.write('budgetline: ' + (err && err.message ? err.message : String(err)) + '\\n');
  }
}
`;
}

/** Write (or refresh) the launcher; private to the user where the OS supports it. */
export function writeLauncher(data: string, fallbackCli = currentCli()): string {
  const file = launcherPath(data);
  mkdirSync(join(data, 'bin'), { recursive: true, mode: 0o700 });
  writeAtomic(file, launcherSource(fallbackCli));
  try {
    chmodSync(file, 0o700);
  } catch {
    // Windows: permissions are not POSIX modes
  }
  return file;
}

/**
 * A path as one shell word that Claude Code can run in bash (macOS, Linux, Git Bash) and in
 * PowerShell on Windows: forward slashes in double quotes. Characters those shells expand
 * inside double quotes are escaped for bash, and refused on Windows, where no escape works
 * in both shells.
 */
export function shellQuote(path: string, platform: NodeJS.Platform = process.platform): string {
  const p = platform === 'win32' ? path.replace(/\\/g, '/') : path;
  if (platform === 'win32') {
    if (/["$`]/.test(p)) throw new Error(`cannot write a status line command for a path with " $ or \` in it: ${p}. Set BUDGETLINE_DATA to a plain folder and run it again.`);
    return `"${p}"`;
  }
  return `"${p.replace(/[\\"$`]/g, '\\$&')}"`;
}

/** The settings.json command: node from PATH (as the plugin hooks use) + the stable launcher. */
export function launcherCommand(data: string, platform: NodeJS.Platform = process.platform): string {
  return `node ${shellQuote(launcherPath(data), platform)} statusline run`;
}

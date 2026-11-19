import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { freshState } from '../src/guard-state.js';
import { windowSize } from '../src/guard.js';
import { DEFAULTS } from '../src/config.js';
import { launcherCommand, launcherPath, shellQuote, writeLauncher } from '../src/launcher.js';
import { dataDir } from '../src/paths.js';
import { install, run, uninstall } from '../src/statusline.js';
import { tmp } from './helpers.js';

/** A fake budgetline CLI that prints which copy ran and its arguments. */
function fakeCli(dir: string, name: string): string {
  mkdirSync(join(dir, 'dist'), { recursive: true });
  const cli = join(dir, 'dist', 'cli.js');
  writeFileSync(cli, `export async function main(a) { process.stdout.write(${JSON.stringify(name)} + ':' + a.join(' ')); return 0; }\n`);
  return cli;
}

/** A plugins root with installed_plugins.json listing budgetline at the given install paths (newest last). */
function pluginsRoot(installs: string[]): string {
  const root = tmp();
  const list = installs.map((installPath, i) => ({ scope: 'user', installPath, version: `0.${i}.0`, lastUpdated: `2026-11-1${i}T00:00:00Z` }));
  writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({ version: 2, plugins: { 'budgetline@budgetline': list, 'other@x': [] } }));
  return root;
}

function launch(data: string, root: string): string {
  const r = spawnSync(process.execPath, [launcherPath(data), 'statusline', 'run'], { encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_PLUGIN_CACHE_DIR: root } });
  return r.stdout;
}

describe('stable status line launcher (e)', () => {
  it('after a plugin update, finds the new version from installed_plugins.json', () => {
    const root = tmp();
    const v1 = join(root, 'cache', 'budgetline', 'budgetline', '0.2.0');
    const v2 = join(root, 'cache', 'budgetline', 'budgetline', '0.3.0');
    fakeCli(v2, 'v2');
    writeFileSync(join(root, 'installed_plugins.json'), JSON.stringify({ plugins: { 'budgetline@budgetline': [{ installPath: v1, lastUpdated: '2026-11-01' }, { installPath: v2, lastUpdated: '2026-11-19' }] } }));
    const data = tmp();
    writeLauncher(data, join(v1, 'dist', 'cli.js')); // installed from 0.2.0, whose folder is now gone
    expect(launch(data, root)).toBe('v2:statusline run');
  });

  it('prefers the copy that installed it when that is a stable folder (a clone)', () => {
    const clone = fakeCli(tmp(), 'clone');
    const plugin = tmp();
    fakeCli(plugin, 'plugin');
    const data = tmp();
    writeLauncher(data, clone);
    expect(launch(data, pluginsRoot([plugin]))).toBe('clone:statusline run');
  });

  it('says clearly what to do when no install is found', () => {
    const data = tmp();
    writeLauncher(data, join(tmp(), 'gone', 'dist', 'cli.js'));
    expect(launch(data, tmp())).toMatch(/^budgetline: install not found .*setup-statusline --write/);
  });

  it('install writes the launcher and points settings.json at it; re-install keeps one entry', () => {
    const dir = tmp();
    const p = { settings: join(dir, 'settings.json'), data: tmp() };
    writeFileSync(p.settings, JSON.stringify({ theme: 'dark' }));
    install(p);
    expect(existsSync(launcherPath(p.data))).toBe(true);
    const cmd = JSON.parse(readFileSync(p.settings, 'utf8')).statusLine.command;
    expect(cmd).toBe(launcherCommand(p.data));
    expect(cmd).toMatch(/^node ".*budgetline\.mjs" statusline run$/);
    expect(install(p)).toContain('already installed');
    expect(uninstall(p)).toContain('Uninstalled');
    expect(JSON.parse(readFileSync(p.settings, 'utf8'))).toEqual({ theme: 'dark' });
  });
});

describe('command quoting (2)', () => {
  it('keeps spaces in one word and escapes what bash expands inside double quotes', () => {
    expect(shellQuote('/home/a b/.budgetline/bin/budgetline.mjs', 'linux')).toBe('"/home/a b/.budgetline/bin/budgetline.mjs"');
    expect(shellQuote('/home/a$HOME`id`"x\\y/l.mjs', 'darwin')).toBe('"/home/a\\$HOME\\`id\\`\\"x\\\\y/l.mjs"');
  });

  it('uses forward slashes on Windows and refuses characters no shell escape covers', () => {
    expect(shellQuote('D:\\Home\\Ana María\\.budgetline\\bin\\budgetline.mjs', 'win32')).toBe('"D:/Home/Ana María/.budgetline/bin/budgetline.mjs"');
    expect(() => shellQuote('D:\\Home\\a$b\\x.mjs', 'win32')).toThrow(/BUDGETLINE_DATA/);
  });

  it('the generated command really runs through a shell from a folder with spaces and quotes', () => {
    const data = join(tmp(), process.platform === 'win32' ? 'my data' : 'my "data" $x');
    mkdirSync(data, { recursive: true });
    writeLauncher(data, fakeCli(tmp(), 'ok'));
    const r = spawnSync(launcherCommand(data), { shell: true, encoding: 'utf8', env: { ...process.env, CLAUDE_CODE_PLUGIN_CACHE_DIR: tmp() } });
    expect(r.stdout).toBe('ok:statusline run');
  });
});

describe('settings.json safety (3, 4)', () => {
  it('refuses invalid JSON with the file name and changes nothing', () => {
    const dir = tmp();
    const p = { settings: join(dir, 'settings.json'), data: tmp() };
    writeFileSync(p.settings, '{ "theme": "dark", ');
    expect(() => install(p)).toThrow(/settings\.json is not valid JSON .*Nothing was changed/);
    expect(readFileSync(p.settings, 'utf8')).toBe('{ "theme": "dark", ');
  });

  it('leaves no temporary files behind', () => {
    const dir = tmp();
    const p = { settings: join(dir, 'settings.json'), data: tmp() };
    install(p);
    expect(readdirSync(dir).filter((f) => f.includes('.tmp-'))).toEqual([]);
  });
});

describe('guard window (1)', () => {
  it('learns the window from a wrapped status line too', () => {
    const dir = tmp();
    const p = { settings: join(dir, 'settings.json'), data: tmp() };
    writeFileSync(p.settings, JSON.stringify({ statusLine: { type: 'command', command: 'echo mine' } }));
    install(p);
    writeFileSync(join(p.data, 'config.json'), JSON.stringify({ guardEnabled: true }));
    expect(run(JSON.stringify({ session_id: 's1', context_window: { context_window_size: 1_000_000 } }), p)).toBe('mine');
    expect(JSON.parse(readFileSync(join(p.data, 'guard', 's1.json'), 'utf8')).window).toBe(1_000_000);
  });

  it('never assumes a window smaller than a request already seen', () => {
    const s = { ...freshState(), context: 300_000 };
    expect(windowSize(DEFAULTS, s)).toBe(1_000_000);
    expect(windowSize(DEFAULTS, { ...s, context: 100_000 })).toBe(200_000);
  });
});

describe('private data folder (5)', () => {
  it.skipIf(process.platform === 'win32')('is created readable by the user only', () => {
    const dir = join(tmp(), 'data');
    dataDir({ BUDGETLINE_DATA: dir });
    expect(statSync(dir).mode & 0o777).toBe(0o700);
  });
});

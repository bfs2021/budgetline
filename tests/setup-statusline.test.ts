import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { setupStatusline, type SetupOptions } from '../src/setup-statusline.js';
import { tmp } from './helpers.js';

const CMD = '"C:/Program Files/nodejs/node.exe" "C:/x y/budgetline/dist/cli.js" statusline run --budgetline';

function opts(o: Partial<SetupOptions> = {}): SetupOptions {
  const dir = tmp();
  return { write: false, yes: false, interactive: true, paths: { settings: join(dir, 'settings.json'), data: tmp() }, command: CMD, ask: async () => true, ...o };
}

describe('setup-statusline', () => {
  it('only prints the entry, as valid JSON with the quoted command, without --write', async () => {
    const o = opts();
    const out = await setupStatusline(o);
    const json = out.slice(out.indexOf('{'), out.lastIndexOf('}') + 1);
    expect(JSON.parse(json)).toEqual({ statusLine: { type: 'command', command: CMD } });
    expect(existsSync(o.paths.settings)).toBe(false);
  });

  it('writes after a yes and keeps the other settings', async () => {
    const o = opts({ write: true });
    writeFileSync(o.paths.settings, JSON.stringify({ theme: 'dark' }));
    expect(await setupStatusline(o)).toContain('Installed');
    expect(JSON.parse(readFileSync(o.paths.settings, 'utf8'))).toEqual({ theme: 'dark', statusLine: { type: 'command', command: CMD } });
  });

  it('writes nothing after a no, and refuses without a terminal unless --yes', async () => {
    const no = opts({ write: true, ask: async () => false });
    expect(await setupStatusline(no)).toBe('Nothing written.');
    expect(existsSync(no.paths.settings)).toBe(false);
    await expect(setupStatusline(opts({ write: true, interactive: false }))).rejects.toThrow('--yes');
    const yes = opts({ write: true, interactive: false, yes: true });
    expect(await setupStatusline(yes)).toContain('Installed');
  });
});

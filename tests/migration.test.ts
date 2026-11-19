import { describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { LEGACY_NAME, dataDir } from '../src/paths.js';
import { install, uninstall } from '../src/statusline.js';
import { tmp } from './helpers.js';

describe('migration from the old name', () => {
  it('moves the old data folder once and keeps every file', () => {
    const home = tmp();
    const legacy = join(home, `.${LEGACY_NAME}`);
    mkdirSync(join(legacy, 'sub'), { recursive: true });
    writeFileSync(join(legacy, 'limits.jsonl'), '{"a":1}\n');
    writeFileSync(join(legacy, 'sub', 'x.json'), '{}');
    const dir = dataDir({}, home);
    expect(dir).toBe(join(home, '.budgetline'));
    expect(readFileSync(join(dir, 'limits.jsonl'), 'utf8')).toBe('{"a":1}\n');
    expect(existsSync(join(dir, 'sub', 'x.json'))).toBe(true);
    expect(existsSync(legacy)).toBe(false);
  });

  it('never touches the old folder when the new one exists', () => {
    const home = tmp();
    mkdirSync(join(home, `.${LEGACY_NAME}`));
    mkdirSync(join(home, '.budgetline'));
    writeFileSync(join(home, '.budgetline', 'config.json'), '{"new":true}');
    dataDir({}, home);
    expect(existsSync(join(home, `.${LEGACY_NAME}`))).toBe(true);
    expect(readFileSync(join(home, '.budgetline', 'config.json'), 'utf8')).toBe('{"new":true}');
  });

  it('BUDGETLINE_DATA wins and skips the migration', () => {
    const home = tmp();
    mkdirSync(join(home, `.${LEGACY_NAME}`));
    const custom = join(tmp(), 'data');
    expect(dataDir({ BUDGETLINE_DATA: custom }, home)).toBe(custom);
    expect(existsSync(join(home, `.${LEGACY_NAME}`))).toBe(true);
  });

  it('recognises a wrapper installed under the old name, updates it and can uninstall it', () => {
    const dir = tmp();
    const p = { settings: join(dir, 'settings.json'), data: tmp() };
    const old = `"node" "/x/${LEGACY_NAME}/dist/cli.js" statusline run --${LEGACY_NAME}`;
    writeFileSync(p.settings, JSON.stringify({ statusLine: { type: 'command', command: old } }));
    writeFileSync(join(p.data, 'statusline-backup.json'), JSON.stringify({ original: null }));
    const now = '"node" "/y/budgetline/dist/cli.js" statusline run --budgetline';
    expect(install(p, now)).toContain('Updated');
    expect(JSON.parse(readFileSync(p.settings, 'utf8')).statusLine.command).toBe(now);
    expect(uninstall(p)).toContain('Uninstalled');
    expect(JSON.parse(readFileSync(p.settings, 'utf8'))).toEqual({});
  });
});

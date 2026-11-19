import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const read = (f: string) => readFileSync(f, 'utf8');

describe('plugin wiring and bundle', () => {
  it('every command and hook runs the one bundled file from the plugin root', () => {
    expect(read('commands/estimate.md')).toContain('node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" estimate');
    expect(read('commands/budget.md')).toContain('node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" guard session --session "${CLAUDE_SESSION_ID}"');
    const hooks = JSON.parse(read('hooks/hooks.json')).hooks;
    for (const groups of Object.values(hooks) as { hooks: { command: string; args: string[] }[] }[][]) {
      for (const h of groups.flatMap((g) => g.hooks)) {
        expect(h.command).toBe('node');
        expect(h.args[0]).toBe('${CLAUDE_PLUGIN_ROOT}/dist/cli.js');
      }
    }
  });

  it('dist/cli.js is self-contained: no imports other than node: built-ins', () => {
    const src = read('dist/cli.js');
    expect(src.startsWith('#!/usr/bin/env node')).toBe(true);
    const specs = [...src.matchAll(/(?:from|import\()\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(specs.filter((s) => !s?.startsWith('node:'))).toEqual([]);
  });

  it('/budgetline:budget: the bundled CLI sets and clears a session budget and says when the guard is off', () => {
    const env = { ...process.env, BUDGETLINE_DATA: mkdtempSync(join(tmpdir(), 'bl-budget-')), CLAUDE_CODE_SESSION_ID: '' };
    const run = (...a: string[]) => spawnSync(process.execPath, ['dist/cli.js', 'guard', 'session', '--session', 'abcdef123456', ...a], { encoding: 'utf8', env });
    const set = run('--budget', '60000', '--warn', '80%');
    expect(set.status).toBe(0);
    expect(set.stdout).toContain('Session abcdef12: budget 60k, warning at 48k.');
    expect(set.stdout).toContain('The guard is disabled');
    expect(run('--clear').stdout).toContain('back to the global budget');
  });

  it('dist/cli.js runs and prints the help', () => {
    const r = spawnSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('budgetline setup-statusline');
  });
});

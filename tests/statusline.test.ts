import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hookOutput } from '../src/hook.js';
import { install, ownLine, run, status, toSample, uninstall, type Paths } from '../src/statusline.js';
import { parseSession } from '../src/transcripts/parse.js';
import { L, tmp } from './helpers.js';

const WRAPPER = '"node" "/x/budgetline/dist/cli.js" statusline run --budgetline';

function setup(settings?: object): Paths {
  const dir = tmp();
  const p = { settings: join(dir, 'settings.json'), data: tmp() };
  if (settings) writeFileSync(p.settings, JSON.stringify(settings));
  return p;
}

const read = (f: string) => JSON.parse(readFileSync(f, 'utf8'));

const INPUT = {
  session_id: 's1',
  model: { id: 'claude-test-1' },
  cost: { total_cost_usd: 1.25 },
  rate_limits: { five_hour: { used_percentage: 23.5, resets_at: 100 }, seven_day: { used_percentage: 41, resets_at: 200 } },
  transcript_path: '/secret/path.jsonl',
};

describe('statusline wrapper', () => {
  it('wraps an existing status line and restores it exactly', () => {
    const original = { type: 'command', command: 'node -e "process.stdin.pipe(process.stdout)"', padding: 1 };
    const p = setup({ theme: 'dark', statusLine: original });
    install(p, WRAPPER);
    const after = read(p.settings);
    expect(after.theme).toBe('dark');
    expect(after.statusLine.command).toBe(WRAPPER);
    expect(after.statusLine.padding).toBe(1);
    expect(install(p, WRAPPER)).toContain('already installed');
    expect(uninstall(p)).toContain('Uninstalled');
    expect(read(p.settings)).toEqual({ theme: 'dark', statusLine: original });
  });

  it('removes the key on uninstall when there was no status line, and never touches a foreign one', () => {
    const p = setup({ theme: 'dark' });
    install(p, WRAPPER);
    uninstall(p);
    expect(read(p.settings)).toEqual({ theme: 'dark' });
    const q = setup({ statusLine: { type: 'command', command: 'mine.sh' } });
    expect(uninstall(q)).toContain('left unchanged');
    expect(read(q.settings).statusLine.command).toBe('mine.sh');
  });

  it('logs metrics only and passes the same input to the original status line', () => {
    const p = setup({ statusLine: { type: 'command', command: 'node -e "process.stdin.pipe(process.stdout)"' } });
    install(p, WRAPPER);
    const out = run(JSON.stringify(INPUT), p);
    expect(JSON.parse(out).session_id).toBe('s1');
    const log = readFileSync(join(p.data, 'limits.jsonl'), 'utf8');
    expect(log).not.toContain('secret');
    expect(JSON.parse(log)).toMatchObject({ session: 's1', cost: 1.25, five: 23.5, fiveReset: 100, seven: 41 });
    expect(status(p)).toContain('installed');
  });

  it('shows its own line without an original status line and survives bad input', () => {
    const p = setup();
    install(p, WRAPPER);
    expect(run(JSON.stringify(INPUT), p)).toBe('5h: 24% · 7d: 41% · $1.25 API value this session');
    expect(run(JSON.stringify({ cost: { total_cost_usd: 0.5 } }), p)).toBe('$0.5 this session');
    expect(run('not json', p)).toBe('budgetline');
    rmSync(join(p.data, 'limits.jsonl'));
    expect(existsSync(join(p.data, 'limits.jsonl'))).toBe(false);
    expect(toSample({ cost: {} })).toBeNull();
  });
});

describe('hook', () => {
  const sessions = () => {
    const lines = [L.cost('claude-test-1', 50)];
    for (let i = 0; i < 6; i++) lines.push(L.prompt(`migrate the database schema ${i}`, `2026-01-01T10:0${i}:00.000Z`), L.reply(`m${i}`, `2026-01-01T10:0${i}:30.000Z`, { input: 900_000 }));
    return [parseSession(lines.join('\n'))!];
  };
  const input = JSON.stringify({ prompt: 'migrate the database schema', cwd: tmp() });

  it('does nothing unless enabled', () => {
    expect(hookOutput(input, tmp(), sessions)).toBe('');
  });

  it('warns without blocking when enabled and the task looks big', () => {
    const dir = tmp();
    writeFileSync(join(dir, 'hook.json'), JSON.stringify({ enabled: true })); // old format: migrated on read
    const out = JSON.parse(hookOutput(input, dir, sessions));
    expect(existsSync(join(dir, 'hook.json'))).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'))).toMatchObject({ hookEnabled: true });
    expect(out.systemMessage).toContain('budgetline');
    expect(out.decision).toBeUndefined();
    expect(hookOutput('garbage', dir, sessions)).toBe('');
  });
});

describe('own status line', () => {
  const ctx = (n: number) => JSON.stringify({ cost: { total_cost_usd: 2 }, context_window: { current_usage: { input_tokens: 10, cache_read_input_tokens: n } } });

  it('has no fixed long-session warning; an old longSessionTokens setting is ignored', () => {
    expect(ownLine(ctx(150_000))).toBe('$2 this session');
    const p = setup();
    writeFileSync(join(p.data, 'config.json'), JSON.stringify({ longSessionTokens: 40_000 }));
    install(p, WRAPPER);
    expect(run(ctx(50_000), p)).toBe('$2 this session');
  });
});

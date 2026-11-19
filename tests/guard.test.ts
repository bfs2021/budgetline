import { describe, expect, it } from 'vitest';
import { appendFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { guardOutput, recordWindow } from '../src/guard.js';
import { DEFAULTS, warnTokens, writeConfig } from '../src/config.js';
import { readState } from '../src/guard-state.js';
import { ownLine } from '../src/statusline.js';
import { L, tmp } from './helpers.js';

const T = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, '0')}.000Z`;

function setup(config: Record<string, unknown> = {}) {
  const dir = tmp();
  writeConfig(dir, { guardEnabled: true, ...config });
  const transcript = join(tmp(), 't.jsonl');
  writeFileSync(transcript, L.prompt('go', T(0)) + '\n');
  const call = (event = 'PostToolBatch') =>
    guardOutput(JSON.stringify({ session_id: 's1', transcript_path: transcript, hook_event_name: event }), dir);
  /** Append one response: `read` tokens of cached context, `output` tokens of output (eq = read*0.1 + output*5). */
  const reply = (id: string, read: number, output = 0) => appendFileSync(transcript, L.reply(id, T(1), { input: 0, read, output }) + '\n');
  return { dir, transcript, call, reply };
}

describe('guard', () => {
  it('does nothing when disabled (the default) or on bad input', () => {
    const dir = tmp();
    expect(guardOutput(JSON.stringify({ session_id: 's', transcript_path: 'x', hook_event_name: 'PostToolBatch' }), dir)).toBe('');
    const { dir: on } = setup();
    expect(guardOutput('not json', on)).toBe('');
    expect(guardOutput(JSON.stringify({ session_id: 's', transcript_path: '/missing.jsonl', hook_event_name: 'PostToolBatch' }), on)).toBe('');
  });

  it('warns once at the session warning, then keeps telling the model once over budget', () => {
    const { call, reply } = setup({ sessionBudgetTokens: 1000, sessionWarnTokens: '80%' });
    reply('a', 0, 100); // eq 500
    expect(call()).toBe('');
    reply('b', 0, 70); // eq 850: past the 800 warning
    const warn = JSON.parse(call());
    expect(warn.hookSpecificOutput).toEqual({ hookEventName: 'PostToolBatch', additionalContext: expect.stringContaining('session at Equiv 850/1k') });
    expect(warn.systemMessage).toContain('budgetline: session at');
    expect(call()).toBe(''); // not repeated
    reply('c', 0, 100); // eq 1350: over budget
    expect(JSON.parse(call('UserPromptSubmit')).hookSpecificOutput.additionalContext).toContain('Do not start new work');
    expect(JSON.parse(call()).hookSpecificOutput.additionalContext).toContain('continuation prompt');
  });

  it('counts a response repeated over several lines once, reading only new lines', () => {
    const { call, reply, dir } = setup();
    reply('a', 0, 100);
    reply('a', 0, 100);
    call();
    reply('b', 0, 100);
    call();
    expect(readState(dir, 's1').eq).toBe(1000);
  });

  it('warns about a full context from the latest response, once, and again after it drops', () => {
    const { call, reply } = setup({ contextWindowTokens: 100_000 });
    reply('a', 50_000);
    expect(call()).toBe('');
    reply('b', 72_000);
    const out = JSON.parse(call());
    expect(out.hookSpecificOutput.additionalContext).toContain('context at 72% of window; answer quality may degrade');
    expect(out.hookSpecificOutput.additionalContext).toContain('Tell the user');
    reply('c', 75_000);
    expect(call()).toBe('');
    reply('d', 20_000); // after /compact
    call();
    reply('e', 80_000);
    expect(call()).toContain('context at 80%');
  });

  it('uses the window size the status line reported', () => {
    const { call, reply, dir } = setup();
    recordWindow(dir, 's1', 1_000_000);
    reply('a', 300_000);
    expect(call()).toBe(''); // 30% of 1M, not 150% of 200k
  });

  it('prefers the status line window over a configured one', () => {
    const { call, reply, dir } = setup({ contextWindowTokens: 200_000 });
    recordWindow(dir, 's1', 1_000_000);
    reply('a', 230_000);
    expect(call()).toBe(''); // 23% of 1M; the configured 200k would say 115%
  });

  it('accepts a percentage or an absolute warning', () => {
    expect(warnTokens({ ...DEFAULTS, sessionWarnTokens: '80%' })).toBe(160_000);
    expect(warnTokens({ ...DEFAULTS, sessionWarnTokens: 150_000 })).toBe(150_000);
  });

  it('shows both states in the own status line', () => {
    const { reply, dir, transcript } = setup({ sessionBudgetTokens: 1000, sessionWarnTokens: 800 });
    reply('a', 0, 180); // eq 900
    const input = (used: number) => JSON.stringify({ session_id: 's1', transcript_path: transcript, context_window: { used_percentage: used } });
    expect(ownLine(input(72), dir)).toBe('Equiv 900/1k ⚠ · ctx 72% ⚠');
    expect(ownLine(input(40), dir)).toBe('Equiv 900/1k ⚠ · ctx 40%');
  });
});

import { proposeBudget } from '../src/guard.js';

describe('guard budget proposal', () => {
  it('uses the 75th percentile of recent sessions, or 2M without enough history', () => {
    const s = (eq: number, i: number) => ({ start: `2026-01-${String(i + 1).padStart(2, '0')}`, eq });
    expect(proposeBudget([1, 2, 3, 4, 5].map((k, i) => s(k * 1_000_000, i)))).toMatchObject({ budget: 4_000_000 });
    expect(proposeBudget([1, 2, 3, 4, 5].map((k, i) => s(k * 1_000_000, i))).note).toContain('last 5 sessions');
    expect(proposeBudget([s(1, 0)]).budget).toBe(2_000_000);
  });
});

import { guardCommand, guardFigure, sessionBudget } from '../src/guard.js';
import { dateArg, parseArgs } from '../src/args.js';

const args = (...a: string[]) => parseArgs(a, ['session', 'budget', 'warn', 'context', 'window', 'since']);

describe('guard: one session budget', () => {
  it('warns at the session budget instead of the global one, and only for that session', () => {
    const { dir, call, reply } = setup({ sessionBudgetTokens: 5_000_000, sessionWarnTokens: '80%' });
    expect(sessionBudget(args('--budget', '1000'), dir, { CLAUDE_CODE_SESSION_ID: 's1' })).toBe('Session s1: budget 1k, warning at 800.');
    reply('a', 0, 170); // eq 850: past 80% of 1k, far below 80% of 5M
    expect(JSON.parse(call()).systemMessage).toContain('session at Equiv 850/1k');
    expect(guardFigure(dir, 's1')).toMatchObject({ budget: 1000, warnAt: 800 });
    expect(guardFigure(dir, 'other')).toMatchObject({ budget: 5_000_000 });
    expect(readState(dir, 's1').budget).toBe(1000); // kept by the hook's own writes
  });

  it('clears back to the global budget; needs a session and a valid budget', () => {
    const { dir } = setup({ sessionBudgetTokens: 2_000_000 });
    sessionBudget(args('--session', 's9', '--budget', '1200000', '--warn', '1000000'), dir, {});
    expect(guardFigure(dir, 's9')).toMatchObject({ budget: 1_200_000, warnAt: 1_000_000 });
    expect(sessionBudget(args('--session', 's9', '--clear'), dir, {})).toContain('back to the global budget (2M)');
    expect(() => sessionBudget(args('--budget', '1000'), dir, {})).toThrow(/no session/);
    expect(() => sessionBudget(args('--session', 's9', '--budget', 'abc'), dir, {})).toThrow(/--budget must be a positive number/);
  });
});

describe('argument validation (review finding 11)', () => {
  it('rejects bad --warn, --budget, --context and --since instead of ignoring them', () => {
    process.env.BUDGETLINE_DATA = tmp();
    expect(() => guardCommand(args('enable', '--budget', '-1'))).toThrow(/--budget must be a positive number/);
    expect(() => guardCommand(args('enable', '--budget', '1000', '--warn', 'abc'))).toThrow(/--warn must be a positive number/);
    expect(() => guardCommand(args('enable', '--budget', '1000', '--warn', '150%'))).toThrow(/--warn/);
    expect(() => guardCommand(args('enable', '--budget', '1000', '--context', '200'))).toThrow(/1-100/);
    expect(guardCommand(args('enable', '--budget', '1000', '--warn', '50%'))).toContain('warning at 500');
    expect(() => dateArg(args('--since', '2026-13'), 'since')).toThrow(/--since must be a date/);
    expect(() => dateArg(args('--since', '2026-02-30'), 'since')).toThrow(/--since/);
    expect(dateArg(args('--since', '2026-02'), 'since')).toBe('2026-02');
    expect(dateArg(args(), 'since')).toBeUndefined();
    delete process.env.BUDGETLINE_DATA;
  });
});

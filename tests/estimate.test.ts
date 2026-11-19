import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { calibrate, readBilling, type LimitSample } from '../src/calibration.js';
import { estimateJson, renderEstimate, runEstimate } from '../src/estimate-cmd.js';
import { citedPaths, repoContext } from '../src/repo-context.js';
import { parseSession } from '../src/transcripts/parse.js';
import type { Session } from '../src/transcripts/types.js';
import { L, tmp } from './helpers.js';

const T = (m: number) => `2026-01-01T${String(10 + Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00.000Z`;

/** A history with `n` login-related tasks of growing size and some unrelated ones. */
function history(n: number): Session[] {
  const lines: string[] = [L.cost('claude-test-1', 10)];
  for (let i = 0; i < n; i++) {
    lines.push(L.prompt(`fix the login form validation bug ${i}`, T(i * 2)), L.reply(`l${i}`, T(i * 2 + 1), { input: 1000 * (i + 1), output: 100 }));
  }
  for (let i = 0; i < 10; i++) {
    lines.push(L.prompt(`write the billing invoice export ${i}`, T(100 + i * 2)), L.reply(`b${i}`, T(101 + i * 2), { input: 50_000 }));
  }
  return [parseSession(lines.join('\n'))!];
}

describe('estimate', () => {
  it('uses similar past tasks and states its basis without prompt text', () => {
    const r = runEstimate(history(8), 'login validation is broken', tmp(), null)!;
    expect(r.est.basis.kind).toBe('similar');
    expect(r.est.basis.rows).toHaveLength(8);
    expect(r.eq.typical).toBeLessThan(10_000);
    expect(r.usd).not.toBeNull();
    const text = renderEstimate(r);
    expect(text).toContain('Based on 8 similar past tasks');
    expect(text).toContain('Usage-limit %: none seen');
    expect(text).not.toMatch(/fix the login form/);
    expect(estimateJson(r)).not.toMatch(/fix the login form/);
  });

  it('falls back to the global distribution and says so when few tasks match', () => {
    const r = runEstimate(history(2), 'deploy kubernetes cluster', tmp(), null)!;
    expect(r.est.fewData).toBe(true);
    expect(renderEstimate(r)).toContain('LOW CONFIDENCE');
  });

  it('flags a wide range', () => {
    const r = runEstimate(history(8), 'login validation', tmp(), null)!;
    expect(r.est.wide).toBe(r.eq.high / r.eq.low > 10);
    expect(runEstimate([], 'x', tmp(), null)).toBeNull();
  });

  it('adds cited files and shows the limit % once calibrated', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'src'));
    writeFileSync(join(dir, 'src', 'big.ts'), 'x'.repeat(400_000));
    writeFileSync(join(dir, 'CLAUDE.md'), 'y'.repeat(4000));
    const base = runEstimate(history(8), 'login validation', dir, null)!;
    const cal = { fivePerUsd: 10, sevenPerUsd: null, pairs: 12, usd: 3 };
    const r = runEstimate(history(8), 'login validation in src/big.ts', dir, cal)!;
    expect(r.ctx.citedTokens).toBe(100_000);
    expect(r.ctx.baseTokens).toBe(1000);
    expect(r.eq.typical).toBeGreaterThanOrEqual(base.eq.typical + 200_000);
    expect(r.limit5h!.typical).toBeCloseTo(r.usd!.typical * 10);
    expect(r.tips.join(' ')).toContain('Point to functions or line ranges');
    expect(renderEstimate(r)).toContain('5-hour limit');
  });

  it('puts the limit % first on a plan and the real cost first on the API', () => {
    const cal = { fivePerUsd: 10, sevenPerUsd: null, pairs: 12, usd: 3 };
    const plan = renderEstimate(runEstimate(history(8), 'login validation', tmp(), cal)!);
    expect(plan.indexOf('5-hour limit')).toBeLessThan(plan.indexOf('API-equivalent value:'));
    expect(plan).not.toMatch(/^Cost:/m);
    const api = renderEstimate(runEstimate(history(8), 'login validation', tmp(), null)!);
    expect(api.indexOf('Cost:')).toBeLessThan(api.indexOf('Usage-limit %'));
    expect(api).not.toContain('API-equivalent value:');
    expect(JSON.parse(estimateJson(runEstimate(history(8), 'login', tmp(), cal)!)).usdMeaning).toBe('api-equivalent-value');
  });

  it('detects a plan from status line samples with limit %', () => {
    const file = join(tmp(), 'limits.jsonl');
    writeFileSync(file, `${JSON.stringify({ ts: T(0), session: 's', model: 'm', cost: 1 })}\n`);
    expect(readBilling(file).plan).toBe(false);
    writeFileSync(file, `${JSON.stringify({ ts: T(0), session: 's', model: 'm', cost: 1, five: 3 })}\nnot json\n`);
    expect(readBilling(file)).toEqual({ calibration: null, plan: true });
  });
});

describe('repo context', () => {
  it('detects cited paths', () => {
    expect(citedPaths('update @src/a.ts and docs/x, then stop.')).toEqual(['src/a.ts', 'docs/x']);
    expect(repoContext(tmp(), 'see missing/file.ts').cited).toEqual([]);
    expect(repoContext(tmp(), 'nothing').baseTokens).toBe(0);
  });
});

describe('calibration', () => {
  const s = (session: string, min: number, cost: number, five: number, reset = 1): LimitSample => ({
    ts: T(min), session, model: 'm', cost, five, fiveReset: reset, seven: five / 4, sevenReset: 9,
  });

  it('needs enough pairs and spend, and ignores window resets and other sessions', () => {
    const few = [s('a', 0, 0, 0), s('a', 1, 1, 5)];
    expect(calibrate(few)).toBeNull();
    const many: LimitSample[] = [];
    for (let i = 0; i <= 12; i++) many.push(s('a', i, i * 0.5, i * 2));
    many.push(s('a', 13, 7, 0, 2)); // new window: not paired
    many.push(s('b', 5, 100, 50)); // another session alone: no pair
    const c = calibrate(many)!;
    expect(c.pairs).toBe(12);
    expect(c.fivePerUsd).toBeCloseTo(4);
    expect(c.sevenPerUsd).toBeCloseTo(1);
  });
});

import { taskKind } from '../src/text.js';
import { accuracyLine, evaluate, logEstimate, readLog } from '../src/accuracy.js';
import type { TaskRow } from '../src/history.js';

describe('task kind', () => {
  it('tells questions from changes', () => {
    expect(taskKind('cuantas carpetas hay en este proyecto')).toBe('question');
    expect(taskKind('¿Dónde se valida el login?')).toBe('question');
    expect(taskKind('what does parse.ts do?')).toBe('question');
    expect(taskKind('como añado un test para el parser')).toBe('question');
    expect(taskKind('fix the login bug')).toBe('change');
    expect(taskKind('implementa la spec 002')).toBe('change');
  });

  it.each([
    ['how many files are in src?', 'question'],
    ['is the address field validated?', 'question'],
    ['where are the test fixtures?', 'question'],
    ['does the build pass?', 'question'],
    ['how do I add a route?', 'question'],
    ['can you remove the old flag?', 'change'],
    ['could you write tests for parse.ts?', 'change'],
    ['add a login page', 'change'],
    ['implement the CSV export', 'change'],
    ['refactor the parser', 'change'],
    ['migrate the db to postgres', 'change'],
    ['update the README', 'change'],
    ['¿qué cambios hay en el último commit?', 'question'],
    ['¿puedes añadir un test?', 'change'],
    ['quiero que arregles el login?', 'change'],
    ['crea una página de login', 'change'],
  ])('classifies %s as %s (English and Spanish)', (text, kind) => {
    expect(taskKind(text)).toBe(kind);
  });

  it('compares a question only with past questions and shows the closest tasks', () => {
    const lines: string[] = [L.cost('claude-test-1', 10)];
    for (let i = 0; i < 6; i++) lines.push(L.prompt(`cuantos archivos hay en carpetas ${i}`, T(i * 2)), L.reply(`q${i}`, T(i * 2 + 1), { input: 1000 }));
    for (let i = 0; i < 6; i++) lines.push(L.prompt(`reorganiza las carpetas del proyecto ${i}`, T(50 + i * 2)), L.reply(`c${i}`, T(51 + i * 2), { input: 900_000 }));
    const r = runEstimate([parseSession(lines.join('\n'))!], 'cuantas carpetas hay en este proyecto', tmp(), null)!;
    expect(r.est.taskKind).toBe('question');
    expect(r.eq.high).toBeLessThan(10_000);
    expect(r.est.basis.closest).toHaveLength(3);
    expect(renderEstimate(r)).toMatch(/Closest: .*Session:/s);
  });
});

describe('accuracy', () => {
  const row = (start: string, eq: number, project = '/p'): TaskRow =>
    ({ start, eq, project, sessionId: 's', usd: null, turns: 1 }) as TaskRow;

  it('pairs each estimate with the next task in the project within 2 hours', () => {
    const file = join(tmp(), 'estimates.jsonl');
    logEstimate(file, '/p', { low: 100, typical: 200, high: 400 }, new Date('2026-01-01T10:00:00Z'));
    logEstimate(file, '/p', { low: 100, typical: 200, high: 400 }, new Date('2026-01-01T12:00:00Z'));
    logEstimate(file, '/p', { low: 100, typical: 200, high: 400 }, new Date('2026-01-02T10:00:00Z'));
    const rows = [row('2026-01-01T10:05:00Z', 300), row('2026-01-01T10:30:00Z', 9999), row('2026-01-01T12:10:00Z', 800), row('2026-01-01T12:05:00Z', 5, '/other')];
    const a = evaluate(readLog(file), rows);
    expect(a).toEqual({ n: 2, within: 1, typicalFactor: 2.75 });
    expect(accuracyLine(a)).toBe('Accuracy so far: 2 estimates, 50% within range, typical error ×2.8. Too few to judge yet.');
    expect(accuracyLine({ n: 0, within: 0, typicalFactor: null })).toContain('no estimate checked yet');
  });
});

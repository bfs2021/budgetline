import { describe, expect, it } from 'vitest';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { renderEstimate, runEstimate } from '../src/estimate-cmd.js';
import { repoContext } from '../src/repo-context.js';
import { isReviewOnly } from '../src/text.js';
import { parseSession } from '../src/transcripts/parse.js';
import { L, tmp } from './helpers.js';

const CHEAPER = /cheaper model/;

describe('cheaper-model tip only for review-only work (b)', () => {
  it.each([
    // the reported case: an implementation prompt that mentions review/docs words
    'Rename pre-budget to budgetline, review the README and docs, ship one bundle in dist/cli.js, then run the build and the tests',
    'Renombra pre-budget a budgetline, revisa el README, compila el bundle y pasa los tests',
    'document the new flag and add a test for it',
    'resume where we left off and fix the failing tests',
    'explain the bug and then fix it',
  ])('no tip for implementation work: %s', (text) => {
    expect(isReviewOnly(text)).toBe(false);
  });

  it.each(['review src/estimate.ts', 'explica cómo calcula el rango src/estimate.ts', 'summarize what parse.ts does', 'describe the cache format'])(
    'tip for review-only work: %s',
    (text) => expect(isReviewOnly(text)).toBe(true),
  );

  it('does not recommend a cheaper model for the reported implementation prompt', () => {
    const lines = [L.cost('claude-test-1', 1)];
    for (let i = 0; i < 6; i++) lines.push(L.prompt(`rename the bundle and run the build ${i}`, `2026-01-01T10:0${i}:00Z`), L.reply(`r${i}`, `2026-01-01T10:0${i}:30Z`, { input: 1000 }));
    const s = [parseSession(lines.join('\n'))!];
    const impl = runEstimate(s, 'Rename pre-budget to budgetline, review the docs, run the build and the tests', tmp(), null)!;
    expect(impl.tips.join('\n')).not.toMatch(CHEAPER);
    const review = runEstimate(s, 'review the parser', tmp(), null)!;
    expect(review.tips.join('\n')).toMatch(CHEAPER);
  });
});

describe('cited files (c)', () => {
  it('lists each file once however it is written, with forward slashes', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'cli.js'), 'x'.repeat(4000));
    const sep = process.platform === 'win32' ? 'dist\\cli.js' :'dist/cli.js';
    const ctx = repoContext(dir, `rebuild dist/cli.js, check ${sep} and ./dist/cli.js and @dist/cli.js.`);
    expect(ctx.cited).toEqual([{ path: 'dist/cli.js', tokens: 1000 }]);
    expect(ctx.citedTokens).toBe(1000);
  });

  it('shows the deduplicated list in the estimate', () => {
    const dir = tmp();
    mkdirSync(join(dir, 'dist'));
    writeFileSync(join(dir, 'dist', 'cli.js'), 'x');
    const s = [parseSession([L.prompt('a b c', '2026-01-01T10:00:00Z'), L.reply('a', '2026-01-01T10:00:30Z')].join('\n'))!];
    const text = renderEstimate(runEstimate(s, 'fix dist/cli.js and ./dist/cli.js', dir, null)!);
    expect(text).toContain('(dist/cli.js).');
  });
});

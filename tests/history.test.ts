import { describe, expect, it } from 'vitest';
import { equivalent, learnPrices, percentile, taskCost } from '../src/cost.js';
import { round2, tokens, usd } from '../src/format.js';
import { buildHistory } from '../src/history.js';
import { patterns } from '../src/insights.js';
import { historyJson, renderHistory } from '../src/render-history.js';
import { parseSession } from '../src/transcripts/parse.js';
import type { Session } from '../src/transcripts/types.js';
import { L } from './helpers.js';

const T = (m: number) => `2026-01-01T10:${String(m).padStart(2, '0')}:00.000Z`;

function session(id: string, withPrompts = false): Session {
  const lines = [
    L.title(`Title ${id}`),
    L.prompt('SECRET refactor the parser', T(0)),
    L.reply(`${id}a`, T(1), { input: 1000, output: 1000 }), // eq 6000
    L.prompt('SECRET tiny fix', T(10)),
    L.reply(`${id}b`, T(11), { input: 100, w1h: 100_000, output: 0 }), // eq 200100, cache-write heavy
    L.cost('claude-test-1', 2.061),
  ];
  const s = parseSession(lines.join('\n'), [], { keepPrompts: withPrompts })!;
  s.id = id;
  return s;
}

describe('cost', () => {
  it('weights tokens and learns the price from reported cost', () => {
    expect(equivalent({ input: 1, cacheWrite5m: 4, cacheWrite1h: 1, cacheRead: 10, output: 1 })).toBe(1 + 5 + 2 + 1 + 5);
    const prices = learnPrices([session('a')]);
    expect(prices['claude-test-1']).toBeCloseTo(2.061 / 206100);
    expect(taskCost(session('a').tasks[0]!, prices)).toBeCloseTo(0.06);
    expect(taskCost(session('a').tasks[0]!, {})).toBeNull();
  });

  it('percentile interpolates and formatting never looks more precise than 2 figures', () => {
    expect(percentile([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentile([10, 20], 0.25)).toBe(12.5);
    expect(round2(237_456)).toBe(240_000);
    expect(tokens(1_234_567)).toBe('1.2M');
    expect(usd(1.2345, true)).toBe('$1.2');
    expect(usd(null)).toBe('n/a');
  });
});

describe('history', () => {
  it('summarizes sessions and flags cache-write heavy tasks', () => {
    const d = buildHistory([session('a'), session('b')], {});
    expect(d.sessions).toHaveLength(2);
    expect(d.tasks).toHaveLength(4);
    const p = patterns(d.tasks);
    expect(p[0]!.id).toBe('cache-writes');
    expect(p[0]!.tasks).toBe(2);
    expect(p[0]!.share).toBeGreaterThan(0.9);
  });

  it('filters by project and date', () => {
    expect(buildHistory([session('a')], { project: 'DEMO' }).sessions).toHaveLength(1);
    expect(buildHistory([session('a')], { project: 'other' }).sessions).toHaveLength(0);
    expect(buildHistory([session('a')], { since: '2027-01-01' }).sessions).toHaveLength(0);
  });

  it('never prints prompt text unless --show-prompts', () => {
    const opts = { limit: 10, showPrompts: false };
    const d = buildHistory([session('a')], {});
    const text = renderHistory(d, opts);
    expect(text).toContain("What's expensive");
    expect(text).toContain('Title a');
    expect(text).not.toContain('SECRET');
    expect(historyJson(d, opts)).not.toContain('SECRET');
    const shown = renderHistory(buildHistory([session('a', true)], {}), { limit: 10, showPrompts: true });
    expect(shown).toContain('SECRET tiny fix');
  });
});

describe('history output by user type', () => {
  it('labels the $ as API-equivalent value on a plan and shows the 5h limit column once calibrated', () => {
    const d = buildHistory([session('a')], {});
    const api = renderHistory(d, { limit: 10, showPrompts: false });
    expect(api).toContain('Cost');
    expect(api).not.toContain('API-equivalent value');
    const cal = { fivePerUsd: 10, sevenPerUsd: null, pairs: 12, usd: 3 };
    const plan = renderHistory(d, { limit: 10, showPrompts: false, plan: true, calibration: cal });
    expect(plan).toContain('API-equivalent value');
    expect(plan).toContain('5h limit');
    expect(JSON.parse(historyJson(d, { limit: 10, showPrompts: false, plan: true })).usdMeaning).toBe('api-equivalent-value');
  });
});

describe('history total (review finding 14)', () => {
  it('marks the $ total with ~ when any session cost is estimated', () => {
    const d = buildHistory([session('a'), session('b')], {});
    const first = () => renderHistory(d, { limit: 10, showPrompts: false }).split('\n')[0]!;
    expect(first()).toContain('equivalent tokens, $4.12');
    d.sessions[1]!.costSource = 'estimated';
    expect(first()).toContain('equivalent tokens, ~$4.1');
  });
});

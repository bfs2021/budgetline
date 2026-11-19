import { describe, expect, it } from 'vitest';
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sessionEquivalent } from '../src/cost.js';
import { advanceFile, sessionEq } from '../src/transcripts/incremental.js';
import { parseTranscript } from '../src/transcripts/scan.js';
import { L, tmp } from './helpers.js';

const T = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, '0')}.000Z`;
const full = (main: string) => sessionEquivalent(parseTranscript(main)!);

function session() {
  const root = tmp();
  const main = join(root, 's1.jsonl');
  const subs = join(root, 's1', 'subagents');
  mkdirSync(subs, { recursive: true });
  writeFileSync(main, [L.prompt('go', T(0)), L.reply('a', T(1), { input: 100, output: 10 })].join('\n') + '\n');
  writeFileSync(join(subs, 'agent-1.jsonl'), L.reply('x', T(2), { read: 1000, output: 5 }) + '\n');
  return { main, subs, data: tmp() };
}

describe('incremental Equiv (review finding 9)', () => {
  it('matches a full parse as main and subagent transcripts grow, counting split responses once', () => {
    const { main, subs, data } = session();
    expect(sessionEq(main, data)).toBe(full(main));
    appendFileSync(main, [L.reply('a', T(1), { input: 100, output: 10 }), L.toolResult(T(3)), L.reply('b', T(4), { w1h: 500, output: 20 })].join('\n') + '\n');
    appendFileSync(join(subs, 'agent-1.jsonl'), L.reply('x', T(2), { read: 1000, output: 5 }) + '\n');
    writeFileSync(join(subs, 'agent-2.jsonl'), L.reply('y', T(5), { input: 7 }) + '\n');
    expect(sessionEq(main, data)).toBe(full(main));
    expect(existsSync(join(data, 'eq', 's1.json'))).toBe(true);
  });

  it('reads only new complete lines, and starts over when a file shrinks', () => {
    const { main } = session();
    const first = advanceFile(main);
    expect(advanceFile(main, first)).toBe(first); // nothing new: same object, no write
    appendFileSync(main, L.reply('c', T(6), { output: 100 }).slice(0, 40)); // half-written line
    expect(advanceFile(main, first).eq).toBe(first.eq);
    writeFileSync(main, L.reply('z', T(7), { input: 0, output: 1 }) + '\n');
    expect(advanceFile(main, first).eq).toBe(5); // output weight 5
  });

  it('is null when the main transcript cannot be read', () => {
    expect(sessionEq(join(tmp(), 'missing.jsonl'), tmp())).toBeNull();
  });
});

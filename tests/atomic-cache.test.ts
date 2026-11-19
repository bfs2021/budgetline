import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { loadSessions } from '../src/transcripts/scan.js';
import { fakeClaudeDir, L, tmp } from './helpers.js';

const renames = vi.hoisted(() => vi.fn<(src: string, dest: string) => void>());
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    renameSync: (src: string, dest: string) => {
      renames(src, dest);
      return actual.renameSync(src, dest);
    },
  };
});

const T = (s: number) => `2026-01-01T10:00:${String(s).padStart(2, '0')}.000Z`;

describe('atomic transcript cache', () => {
  beforeEach(() => renames.mockClear());

  it('installs the cache with rename, never writing the final path in place', () => {
    const dir = fakeClaudeDir({ a: { main: [L.prompt('hi', T(0)), L.reply('1', T(1))] } });
    const cacheFile = join(tmp(), 'index-v1.json');
    loadSessions({ claudeDir: dir, cacheFile });
    expect(renames.mock.calls.some(([, dest]) => dest === cacheFile)).toBe(true);
  });

  it('ignores a broken or partial cache file and rebuilds it', () => {
    const dir = fakeClaudeDir({ a: { main: [L.prompt('hi', T(0)), L.reply('1', T(1))] } });
    const cacheFile = join(tmp(), 'index-v1.json');
    writeFileSync(cacheFile, '{"version":5,"entries":'); // truncated by a concurrent writer
    const sessions = loadSessions({ claudeDir: dir, cacheFile });
    expect(sessions).toHaveLength(1);
    expect(() => JSON.parse(readFileSync(cacheFile, 'utf8'))).not.toThrow();
  });
});

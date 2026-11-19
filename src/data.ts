import { join } from 'node:path';
import type { Parsed } from './args.js';
import { claudeDir, dataDir } from './paths.js';
import { loadSessions } from './transcripts/scan.js';
import type { Session } from './transcripts/types.js';

/** Load all sessions for a command; prompt text only with --show-prompts. */
export function load(p: Parsed): Session[] {
  const keepPrompts = p.flags['show-prompts'] === true;
  return loadSessions({ claudeDir: claudeDir(), cacheFile: join(dataDir(), 'index-v1.json'), keepPrompts });
}

/** Read all of stdin (status line and hook input). */
export async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) return '';
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8');
}

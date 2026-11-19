import type { Parsed } from './args.js';
import { readConfig } from './config.js';
import { load, readStdin } from './data.js';
import { dataDir } from './paths.js';
import type { Session } from './transcripts/types.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- hook output is untyped JSON */

/** Merge hook outputs: messages joined, the guard's additionalContext kept. */
export function mergeOutputs(outputs: string[]): string {
  const parsed = outputs.filter(Boolean).map((o) => JSON.parse(o) as Record<string, any>);
  if (!parsed.length) return '';
  const merged: Record<string, any> = {};
  const messages = parsed.map((o) => o.systemMessage).filter(Boolean);
  if (messages.length) merged.systemMessage = messages.join(' · ');
  const specific = parsed.find((o) => o.hookSpecificOutput)?.hookSpecificOutput;
  if (specific) merged.hookSpecificOutput = specific;
  return JSON.stringify(merged);
}

/**
 * Every hook event in one process: the prompt note (UserPromptSubmit) and the guard.
 * Returns at once, without reading stdin or loading anything, when both are off.
 */
export async function eventsOutput(dir: string, stdin: () => Promise<string>, sessions: () => Session[]): Promise<string> {
  const c = readConfig(dir);
  if (!c.hookEnabled && !c.guardEnabled) return '';
  const input = await stdin();
  const outputs: string[] = [];
  if (c.hookEnabled) outputs.push((await import('./hook.js')).hookOutput(input, dir, sessions, c));
  if (c.guardEnabled) outputs.push((await import('./guard.js')).guardOutput(input, dir, c));
  try {
    return mergeOutputs(outputs);
  } catch {
    return '';
  }
}

export async function eventsCommand(p: Parsed): Promise<string> {
  if (p.positional[0] !== 'run') throw new Error('usage: budgetline events run (called by the plugin hooks)');
  return eventsOutput(dataDir(), readStdin, () => load(p));
}

import { spawnSync } from 'node:child_process';
import { copyFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { Parsed } from './args.js';
import { calibrate, readSamples, type LimitSample } from './calibration.js';
import { logSample } from './limits-log.js';
import { readStdin } from './data.js';
import { sessionEquivalent } from './cost.js';
import { guardFigure, recordWindow } from './guard.js';
import { sessionLine, type SessionFigures } from './session-line.js';
import { parseTranscript } from './transcripts/scan.js';
import { sessionEq } from './transcripts/incremental.js';
import { LEGACY_NAME, claudeDir, dataDir } from './paths.js';
import { readJsonFile, writeAtomic } from './fsutil.js';
import { launcherCommand, writeLauncher } from './launcher.js';

/* eslint-disable @typescript-eslint/no-explicit-any -- settings.json and status line input are untyped JSON */
const MARKER = 'statusline run';

export interface Paths {
  settings: string;
  data: string;
}

function defaultPaths(): Paths {
  return { settings: join(claudeDir(), 'settings.json'), data: dataDir() };
}

const backupFile = (p: Paths) => join(p.data, 'statusline-backup.json');
const limitsFile = (p: Paths) => join(p.data, 'limits.jsonl');

const readJson = readJsonFile;

/** The backup of the user's own status line; never throws (the status line must always print). */
function readOriginal(p: Paths): any {
  try {
    return readJson(backupFile(p))?.original ?? null;
  } catch {
    return null;
  }
}

const writeSettings = (p: Paths, settings: any) => writeAtomic(p.settings, JSON.stringify(settings, null, 2) + '\n');

/** Ours, including a wrapper installed under the old name (migration). */
function isOurs(statusLine: any): boolean {
  const c = statusLine?.command;
  return typeof c === 'string' && c.includes(MARKER) && (c.includes('budgetline') || c.includes(LEGACY_NAME));
}

/** Install (or refresh) the stable launcher and point the status line at it, keeping the user's own. */
export function install(p: Paths = defaultPaths(), command = launcherCommand(p.data)): string {
  const settings = readJson(p.settings) ?? {};
  writeLauncher(p.data);
  if (isOurs(settings.statusLine)) return refresh(p, settings, command);
  if (existsSync(p.settings)) copyFileSync(p.settings, join(p.data, 'settings.before-install.json'));
  writeAtomic(backupFile(p), JSON.stringify({ original: settings.statusLine ?? null }, null, 2));
  settings.statusLine = { ...(settings.statusLine ?? {}), type: 'command', command };
  writeSettings(p, settings);
  const kept = settings.statusLine && readJson(backupFile(p)).original ? ' Your existing status line still runs and shows as before.' : '';
  return `Installed. Claude Code will log usage-limit snapshots to ${limitsFile(p)} (metrics only, no text).${kept}\nUndo with: budgetline statusline uninstall`;
}

/** Already ours: point it at this CLI if it moved (renamed folder, plugin update); keep the backup. */
function refresh(p: Paths, settings: any, command: string): string {
  if (settings.statusLine.command === command) return 'The budgetline status line wrapper is already installed.';
  settings.statusLine = { ...settings.statusLine, command };
  writeSettings(p, settings);
  return `Updated the budgetline status line wrapper to: ${command}`;
}

export function uninstall(p: Paths = defaultPaths()): string {
  const settings = readJson(p.settings) ?? {};
  if (!isOurs(settings.statusLine)) return 'The budgetline wrapper is not the current status line: settings.json left unchanged.';
  const original = readOriginal(p);
  if (original) settings.statusLine = original;
  else delete settings.statusLine;
  writeSettings(p, settings);
  rmSync(backupFile(p), { force: true });
  return `Uninstalled. Status line restored${original ? ` to: ${original.command}` : ' (none)'}. Collected samples stay in ${limitsFile(p)}; delete it if you want.`;
}

export function status(p: Paths = defaultPaths()): string {
  const installed = isOurs(readJson(p.settings)?.statusLine);
  const samples = readSamples(limitsFile(p));
  const c = calibrate(samples);
  const cal = c
    ? `calibrated: ~${c.fivePerUsd.toFixed(1)}% of the 5-hour limit per $1 (${c.pairs} pairs, $${c.usd.toFixed(2)} observed)`
    : 'not calibrated yet (needs ~10 paired samples and $1 of usage)';
  return `Status line wrapper: ${installed ? 'installed' : 'not installed'}. Samples: ${samples.length}. Limit %: ${cal}.`;
}

/** Turn status line input into a metrics-only sample, or null if it has neither cost nor limit data. */
export function toSample(input: any, now = new Date()): LimitSample | null {
  const rl = input?.rate_limits ?? {};
  if (!hasFigures(input, rl)) return null;
  return { ts: now.toISOString(), ...ids(input), ...windowFields(rl.five_hour ?? {}, rl.seven_day ?? {}), ...ctxField(input) };
}

const hasFigures = (input: any, rl: any) => Boolean(rl.five_hour || rl.seven_day) || typeof input?.cost?.total_cost_usd === 'number';

function ctxField(input: any): Partial<LimitSample> {
  const ctx = input?.context_window?.used_percentage;
  return typeof ctx === 'number' ? { ctx } : {};
}

function ids(input: any): Pick<LimitSample, 'session' | 'model' | 'cost'> {
  return { session: String(input.session_id ?? ''), model: String(input.model?.id ?? ''), cost: Number(input.cost?.total_cost_usd ?? 0) };
}

function windowFields(five: any, seven: any): Partial<LimitSample> {
  const out: Partial<LimitSample> = {};
  if (typeof five.used_percentage === 'number') Object.assign(out, { five: five.used_percentage, fiveReset: five.resets_at });
  if (typeof seven.used_percentage === 'number') Object.assign(out, { seven: seven.used_percentage, sevenReset: seven.resets_at });
  return out;
}

/** Log the metrics sample and the real window size (for the guard), whatever line is shown. */
function record(stdin: string, p: Paths): void {
  try {
    const input = JSON.parse(stdin);
    const sample = toSample(input);
    if (sample) logSample(limitsFile(p), sample);
    recordWindow(p.data, String(input?.session_id ?? ''), input?.context_window?.context_window_size);
  } catch {
    // never break the status line
  }
}

/** Log a sample, then run the user's original status line with the same input and return its output. */
export function run(stdin: string, p: Paths = defaultPaths()): string {
  record(stdin, p);
  const original = readOriginal(p);
  if (!original?.command || isOurs(original)) return ownLine(stdin, p.data, false);
  const r = spawnSync(original.command, { input: stdin, shell: true, encoding: 'utf8', timeout: 5000 });
  return (r.stdout ?? '').replace(/\r?\n$/, '');
}

/** The figures in status line input: Claude Code's own cost and %, tokens from the transcript. */
export function figuresFromInput(input: any, dir?: string): SessionFigures {
  const rl = input.rate_limits ?? {};
  const cost = input.cost?.total_cost_usd;
  return {
    five: rl.five_hour?.used_percentage,
    seven: rl.seven_day?.used_percentage,
    usd: typeof cost === 'number' ? cost : null,
    plan: Boolean(rl.five_hour || rl.seven_day),
    eq: transcriptEq(input.transcript_path, dir),
    ctx: input.context_window?.used_percentage,
    guard: dir ? guardFigure(dir, typeof input.session_id === 'string' ? input.session_id : undefined) : undefined,
  };
}

/** Incremental with a data dir (only new lines are read), else a full parse. */
function transcriptEq(path: unknown, dir?: string): number | null {
  if (typeof path !== 'string' || !path) return null;
  if (dir) return sessionEq(path, dir);
  const s = parseTranscript(path);
  return s ? sessionEquivalent(s) : null;
}

/** Our own line when the user had no status line; `budgetline session` prints the same one. */
export function ownLine(stdin: string, dir?: string, record = true): string {
  try {
    const input = JSON.parse(stdin);
    if (dir && record) recordWindow(dir, String(input?.session_id ?? ''), input?.context_window?.context_window_size);
    return sessionLine(figuresFromInput(input ?? {}, dir));
  } catch {
    return 'budgetline';
  }
}

export async function statuslineCommand(p: Parsed): Promise<string> {
  const sub = p.positional[0];
  if (sub === 'install') return install();
  if (sub === 'uninstall') return uninstall();
  if (sub === 'status') return status();
  if (sub === 'run') return run(await readStdin());
  throw new Error('usage: budgetline statusline install | uninstall | status');
}

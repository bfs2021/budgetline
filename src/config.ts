import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/* eslint-disable @typescript-eslint/no-explicit-any -- config files are untyped JSON */

/** Everything budgetline can be told, in one file: <data dir>/config.json. */
export interface Config {
  /** Prompt notes (UserPromptSubmit) for tasks that look expensive. */
  hookEnabled: boolean;
  /** Note only above this typical estimate, in equivalent tokens. */
  hookThreshold: number;
  guardEnabled: boolean;
  sessionBudgetTokens: number;
  /** Absolute tokens or a percentage of the budget, e.g. "80%". */
  sessionWarnTokens: number | string;
  contextWarnPercent: number;
  contextWindowTokens?: number;
}

export const DEFAULTS: Config = {
  hookEnabled: false,
  hookThreshold: 500_000,
  guardEnabled: false,
  sessionBudgetTokens: 200_000,
  sessionWarnTokens: 160_000,
  contextWarnPercent: 70,
};

/** Keys that older versions wrote and this one ignores. */
const RETIRED = ['longSessionTokens'];

const configFile = (dir: string) => join(dir, 'config.json');
const legacyHookFile = (dir: string) => join(dir, 'hook.json');

function readJson(file: string): Record<string, any> {
  try {
    const o = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
    return o && typeof o === 'object' ? o : {};
  } catch {
    return {};
  }
}

/** One-time move of the old hook.json ({enabled, threshold}) into config.json. */
function migrate(dir: string): void {
  if (!existsSync(legacyHookFile(dir))) return;
  const old = readJson(legacyHookFile(dir));
  const cur = readJson(configFile(dir));
  const moved: Record<string, unknown> = {};
  if (typeof old.enabled === 'boolean' && !('hookEnabled' in cur)) moved.hookEnabled = old.enabled;
  if (Number(old.threshold) > 0 && !('hookThreshold' in cur)) moved.hookThreshold = Number(old.threshold);
  try {
    writeFileSync(configFile(dir), JSON.stringify({ ...cur, ...moved }, null, 2));
    rmSync(legacyHookFile(dir), { force: true });
  } catch {
    // read-only data dir: keep using the defaults plus whatever config.json says
  }
}

function stored(dir: string): Record<string, any> {
  migrate(dir);
  const raw = readJson(configFile(dir));
  for (const k of RETIRED) delete raw[k];
  return raw;
}

export function readConfig(dir: string): Config {
  return { ...DEFAULTS, ...stored(dir) };
}

export function writeConfig(dir: string, patch: Partial<Record<keyof Config, unknown>>): void {
  writeFileSync(configFile(dir), JSON.stringify({ ...stored(dir), ...patch }, null, 2));
}

/** Warning threshold in tokens: a number, or "80%" of the budget. */
export function warnTokens(c: Config): number {
  const w = c.sessionWarnTokens;
  if (typeof w === 'string' && w.trim().endsWith('%')) return (c.sessionBudgetTokens * parseFloat(w)) / 100;
  return Number(w);
}

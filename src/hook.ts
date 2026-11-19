import { join } from 'node:path';
import type { Parsed } from './args.js';
import { readLog } from './accuracy.js';
import { readBilling } from './calibration.js';
import { isEstimateRequest } from './text.js';
import { readConfig, writeConfig, type Config } from './config.js';
import { runEstimate, type EstimateResult } from './estimate-cmd.js';
import { tokens, usd } from './format.js';
import { dataDir } from './paths.js';
import type { Session } from './transcripts/types.js';

function setEnabled(dir: string, enabled: boolean): string {
  writeConfig(dir, { hookEnabled: enabled });
  return enabled
    ? 'Hook enabled: prompts that look expensive get a one-line budgetline note. It never blocks a prompt. Disable with: budgetline hook disable'
    : 'Hook disabled.';
}

/**
 * UserPromptSubmit hook body. Returns the hook's stdout: empty (do nothing) unless the hook
 * is enabled and the typical estimate is above the threshold. Never blocks the prompt.
 */
export function hookOutput(input: string, dir: string, sessions: () => Session[], cfg: Config = readConfig(dir)): string {
  if (!cfg.hookEnabled) return '';
  try {
    const { prompt, cwd, session_id: session } = JSON.parse(input);
    if (!isRealPrompt(prompt)) return '';
    const { calibration, plan } = readBilling(join(dir, 'limits.jsonl'));
    const opts = { session: typeof session === 'string' ? session : undefined, log: readLog(join(dir, 'estimates.jsonl')) };
    const r = runEstimate(sessions(), prompt, cwd || process.cwd(), calibration, plan, opts);
    if (!r || r.eq.typical < cfg.hookThreshold) return '';
    return JSON.stringify({ systemMessage: message(r) });
  } catch {
    return '';
  }
}

/** A prompt worth a note: non-empty text that is not an /estimate request. */
const isRealPrompt = (prompt: unknown): prompt is string => typeof prompt === 'string' && prompt.trim() !== '' && !isEstimateRequest(prompt);

function message(r: EstimateResult): string {
  const limit = r.limit5h ? `~${Math.max(1, Math.round(r.limit5h.typical))}% of your 5-hour limit, ` : '';
  const cost = r.usd ? `, ~${usd(r.usd.typical, true)}${r.plan ? ' API-equivalent value' : ''}` : '';
  const note = r.est.fewData || r.est.wide ? ' (low confidence)' : '';
  return `budgetline: this looks like a big task: ${limit}~${tokens(r.eq.typical)} equivalent tokens${cost} typical${note}. Run /estimate for the range and savings tips.`;
}

export function hookCommand(p: Parsed): string {
  const sub = p.positional[0];
  const dir = dataDir();
  if (sub === 'enable') return setEnabled(dir, true);
  if (sub === 'disable') return setEnabled(dir, false);
  if (sub === 'status') return `Hook: ${readConfig(dir).hookEnabled ? 'enabled' : 'disabled (default)'}.`;
  throw new Error('usage: budgetline hook enable | disable | status');
}

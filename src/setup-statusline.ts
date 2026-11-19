import { join } from 'node:path';
import { createInterface } from 'node:readline/promises';
import type { Parsed } from './args.js';
import { claudeDir, dataDir } from './paths.js';
import { launcherCommand, launcherPath } from './launcher.js';
import { install, type Paths } from './statusline.js';

/**
 * Claude Code plugins cannot set the status line (it is not a plugin component, and
 * ${CLAUDE_PLUGIN_ROOT} is not expanded there), so this prints the settings.json entry
 * and, with --write and a confirmation, installs it.
 */
export function entry(command: string): string {
  return JSON.stringify({ statusLine: { type: 'command', command } }, null, 2);
}

export function instructions(settings: string, command: string, data: string): string {
  return [
    `Run \`budgetline setup-statusline --write\` to add this to ${settings}:`,
    '',
    entry(command),
    '',
    `The command runs a small launcher, ${launcherPath(data)}, that --write creates. It finds the`,
    'current budgetline install each time (this copy, else the plugin Claude Code has installed), so the',
    'status line keeps working after plugin updates. If you already have a status line, --write keeps it:',
    'budgetline runs it and shows its output unchanged.',
  ].join('\n');
}

export type Ask = (question: string) => Promise<boolean>;

async function askTty(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return /^y(es)?$/i.test((await rl.question(question)).trim());
  } finally {
    rl.close();
  }
}

export interface SetupOptions {
  write: boolean;
  yes: boolean;
  interactive: boolean;
  paths: Paths;
  command: string;
  ask: Ask;
}

export async function setupStatusline(o: SetupOptions): Promise<string> {
  const text = instructions(o.paths.settings, o.command, o.paths.data);
  if (!o.write) return text;
  if (!o.yes) {
    if (!o.interactive) throw new Error('--write needs a confirmation: run it in a terminal, or add --yes');
    const ok = await o.ask(`${text}\n\nWrite this to ${o.paths.settings}? A backup goes to ${o.paths.data}. [y/N] `);
    if (!ok) return 'Nothing written.';
  }
  return install(o.paths, o.command);
}

export function setupStatuslineCommand(p: Parsed): Promise<string> {
  const dir = dataDir();
  return setupStatusline({
    write: p.flags.write === true,
    yes: p.flags.yes === true,
    interactive: Boolean(process.stdin.isTTY),
    paths: { settings: join(claudeDir(), 'settings.json'), data: dir },
    command: launcherCommand(dir),
    ask: askTty,
  });
}

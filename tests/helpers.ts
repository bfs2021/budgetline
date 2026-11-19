import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Builders for synthetic transcript lines (never real user data). */
export const L = {
  prompt: (text: string, ts: string, extra: object = {}) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: text }, timestamp: ts, cwd: '/work/demo', sessionId: 's1', ...extra }),
  reply: (id: string, ts: string, u: Partial<Record<string, number>> = {}, model = 'claude-test-1') =>
    JSON.stringify({
      type: 'assistant',
      requestId: `req_${id}`,
      timestamp: ts,
      message: {
        id: `msg_${id}`,
        model,
        role: 'assistant',
        usage: {
          input_tokens: u.input ?? 10,
          cache_creation_input_tokens: (u.w5m ?? 0) + (u.w1h ?? 0),
          cache_read_input_tokens: u.read ?? 0,
          output_tokens: u.output ?? 100,
          cache_creation: { ephemeral_5m_input_tokens: u.w5m ?? 0, ephemeral_1h_input_tokens: u.w1h ?? 0 },
        },
      },
    }),
  toolResult: (ts: string) =>
    JSON.stringify({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', content: 'ok' }] }, timestamp: ts }),
  title: (t: string) => JSON.stringify({ type: 'ai-title', aiTitle: t, sessionId: 's1' }),
  cost: (model: string, costUSD: number) =>
    JSON.stringify({ type: 'cost-state', sessionId: 's1', modelUsage: { [model]: { costUSD } } }),
};

export function tmp(prefix = 'pb-'): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** Write a fake ~/.claude with one project holding the given sessions. */
export function fakeClaudeDir(sessions: Record<string, { main: string[]; subagents?: string[][] }>): string {
  const dir = tmp();
  const proj = join(dir, 'projects', 'C--work-demo');
  mkdirSync(proj, { recursive: true });
  for (const [id, s] of Object.entries(sessions)) {
    writeFileSync(join(proj, `${id}.jsonl`), s.main.join('\n') + '\n');
    (s.subagents ?? []).forEach((lines, i) => {
      const sub = join(proj, id, 'subagents');
      mkdirSync(sub, { recursive: true });
      writeFileSync(join(sub, `agent-${i}.jsonl`), lines.join('\n'));
    });
  }
  return dir;
}

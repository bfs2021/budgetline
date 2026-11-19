import { HIGH_BASE_TOKENS, type BaseCost } from './base-cost.js';
import { percentile } from './cost.js';
import type { Estimate } from './estimate.js';
import { tokens } from './format.js';
import { isReviewOnly } from './text.js';
import type { RepoContext } from './repo-context.js';


interface Input {
  description: string;
  est: Estimate;
  ctx: RepoContext;
  base?: BaseCost | null;
}

type Rule = (i: Input) => string | null;

const RULES: Rule[] = [
  ({ base }) =>
    base && base.tokens > HIGH_BASE_TOKENS
      ? `Every message here starts with ~${tokens(base.tokens)} tokens of fixed context. Run /context to see what fills it; disable plugins, MCP servers and skills you do not use in this project and trim CLAUDE.md/rules. Ask related quick questions in the same session: a new session pays the cache write again.`
      : null,
  ({ ctx }) =>
    ctx.citedTokens > 20_000
      ? `The files you cite are ~${tokens(ctx.citedTokens)} tokens. Point to functions or line ranges instead of whole files.`
      : null,
  ({ est }) =>
    est.taskKind === 'question' ? 'For a quick question, ask it in a fresh session (or before a long task) so it does not re-read a long conversation.' : null,
  ({ ctx, est }) =>
    ctx.cited.length === 0 && est.eq.typical > 300_000
      ? 'Name the files involved. Open-ended exploration is where similar tasks got expensive.'
      : null,
  ({ est }) =>
    est.taskKind === 'change' && (est.wide || est.eq.typical > 500_000)
      ? `Split it into smaller steps with a checkpoint each. Similar tasks took ~${Math.round(est.medianTurns)} turns and the expensive ones ran much longer.`
      : null,
  ({ description }) =>
    isReviewOnly(description)
      ? 'This reads like review/explain work: a cheaper model (e.g. /model sonnet or haiku) is usually enough.'
      : null,
  ({ est }) => {
    const share = percentile(est.basis.rows.map((r) => r.cacheWriteShare), 0.5);
    return share > 0.3
      ? `Similar tasks spent ~${Math.round(share * 100)}% on cache writes: do it in one sitting, without long pauses or model switches.`
      : null;
  },
  ({ est }) => {
    const eq = est.basis.rows.reduce((a, r) => a + r.eq, 0);
    const sub = est.basis.rows.reduce((a, r) => a + r.subagentEq, 0);
    return eq > 0 && sub / eq > 0.3
      ? `~${Math.round((sub / eq) * 100)}% of similar tasks went into subagents: ask for a direct approach or a narrower subagent brief.`
      : null;
  },
  ({ ctx }) =>
    ctx.baseTokens > 10_000
      ? `CLAUDE.md and always-loaded rules are ~${tokens(ctx.baseTokens)} tokens, paid on every turn. Trim what this task does not need.`
      : null,
];

/** Up to `max` concrete savings tips, most impactful rules first. */
export function suggestions(input: Input, max = 4): string[] {
  return RULES.map((r) => r(input))
    .filter((s): s is string => s !== null)
    .slice(0, max);
}

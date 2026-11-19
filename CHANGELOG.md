# Changelog

## 0.3.0

First public release. Everything runs locally from the transcripts Claude Code already
writes under `~/.claude/projects/`; nothing is sent anywhere.

- **`budgetline history`**: tokens (input, cache writes, cache reads, output), cost and
  Equiv per session, plus **What's expensive**: your top tasks and the patterns behind the
  spend (long loops, big carried context, subagents, cache rewrites), each with a tip.
  Filters: `--project`, `--since`, `--limit`; `--json` for scripts.
- **`budgetline session`**: the same breakdown for one session.
- **`budgetline estimate "<task>"`**: a low / typical / high range from similar past
  tasks, cost first, with the 3 closest past tasks, confidence warnings and savings tips.
  Each estimate is checked against the task you run next; **Accuracy so far** reports
  how often the range was right.
- **Usage-limit % in the status line** (optional): `5h` and `7d` limit use, the session's
  API value and Equiv. It wraps your existing status line instead of replacing it
  (`statusline install`, `setup-statusline`).
- **Guard** (opt-in): a session token budget and a context-full warning, delivered to
  Claude through hooks so they also work in long autonomous runs. It never blocks.
- **Pre-prompt note** (opt-in): one line added to prompts whose typical estimate is large.
- **Claude Code plugin**: `/budgetline:estimate` and `/budgetline:budget`, plus the
  hooks above, with no install step beyond the plugin itself.
- Node.js 20 or newer, no runtime dependencies, one bundled file.

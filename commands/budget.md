---
description: Set (or clear) a token budget for THIS session only. The guard warns when the session passes it.
argument-hint: "<tokens> [--warn <tokens>|80%] | clear"
allowed-tools: Bash(node:*)
---
Do NOT do any other work. Only set the session budget.

Arguments: $ARGUMENTS

Build the command from the arguments, and accept ONLY these forms (anything else: reply
with one line showing the usage `/budgetline:budget <tokens> [--warn <tokens>|80%]` or
`/budgetline:budget clear`, and run nothing):
- `clear` → `--clear`
- `<tokens>` → `--budget <tokens>` (digits only; `60k` means 60000, `1.5M` means 1500000)
- `<tokens> --warn <tokens>` or `<tokens> --warn <N>%` → add `--warn <value>`

Then run it with the Bash tool, exactly like this (the session id below is this session's):

node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" guard session --session "${CLAUDE_SESSION_ID}" <flags>

If the text after `--session` above is empty or still reads as a `${...}` placeholder,
leave out `--session "..."`: inside Claude Code the CLI then takes the current session
from CLAUDE_CODE_SESSION_ID.

Show the output to the user exactly as printed, in a code block. If the output says
the guard is disabled, add one clear line: the budget is saved, but nothing will warn
until the guard is on; offer to turn it on by running
`node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" guard enable` (run it only if the user says yes).
If the output says dist/cli.js is missing, tell the user to reinstall the plugin.

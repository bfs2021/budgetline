---
description: Estimate what a task will cost (tokens, $, usage-limit %) before running it. Local and private.
argument-hint: "<task description>"
allowed-tools: Bash(node:*)
---
Do NOT start the task below. Only estimate it.

Run this with the Bash tool, passing the task description as ONE safely quoted argument
(escape quotes as needed for the shell):

node "${CLAUDE_PLUGIN_ROOT}/dist/cli.js" estimate --cwd . -- "<task description>"

Task description: $ARGUMENTS

Then show the command output to the user exactly as printed, in a code block, with no
extra commentary beyond one short line if the output reports an error. If the output
says dist/cli.js is missing, tell the user to reinstall the plugin (the file ships with it).

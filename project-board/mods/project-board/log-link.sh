#!/bin/sh
# Claude Code PostToolUse hook (matcher: SendMessage). Logs "agent on task A messaged agent on task B"
# for the project-board mod's green curves. A = task ID in the sender's git branch, B = task ID in the
# recipient's name (sessions are titled with their Notion IDs).
in=$(cat)
log=${HERDR_LINK_LOG:-/tmp/herdr-agent-links.jsonl}
id() { grep -oiE '\b[a-z]{2}-[0-9]+\b' | head -1 | tr a-z A-Z; }
from=$(git -C "$(printf '%s' "$in" | jq -r .cwd)" branch --show-current 2>/dev/null | id)
to=$(printf '%s' "$in" | jq -r '.tool_input.to // empty' | id)
[ -n "$from" ] && [ -n "$to" ] && [ "$from" != "$to" ] &&
  printf '{"ts":%s,"from":"%s","to":"%s"}\n' "$(date +%s)" "$from" "$to" >>"$log"
exit 0

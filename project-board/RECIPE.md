# project-board

A mod: a whiteboard of the person's Notion Tech Tasks (In progress, Queued, and Done until Released).
Cards are draggable, "Blocked by" relations are orthogonal arrows, the agents working each task hang
off its card as avatars, and recent agent-to-agent messages show as fading green curves.

## Placing it

`mod.json` adds a **Project Board** sidebar entry that opens it as a tab named "Board". It takes no props.

## Setup

- **Notion:** `~/.config/notion-board/client.json` holds the public integration's `client_id` and
  `client_secret`. Run `notion-login.py` once: it opens Notion's consent page and writes the token to
  `~/.config/notion-board/token`, which the board reads every 60s.
- **Which tasks:** `DATA_SOURCE` (the Tech Tasks data source) and `ME` (the assignee) at the top of `main.js`.
- **Agents:** a card's dotted avatar starts a herdr-chat tab named after the task, in a worktree of
  `~/$HYPERES` (`Projects/Hyperes`) on branch `<BRANCH_OWNER>/<ID>-<title words>`, with the task ID typed into the composer.
  Agents are matched to tasks by the task ID in their pane, tab, title, branch or space name.
- **PR checks:** `gh pr list` every 30s; the avatar ring shows failed / running / passed.
- **Message curves:** `log-link.sh` is a Claude Code PostToolUse hook (matcher `SendMessage`) that
  appends to `/tmp/herdr-agent-links.jsonl`; the board tails it every 5s.

## State

Shared keys `project-board.pos` (card positions), `.view` (pan and zoom), `.sessions` (each task's
last chat session, so a closed one can be resumed), `.grid-frozen`. Avatars and Lucide icons download
into the mod's `.cache/`. On first load it copies any old `notion-board.*` keys.

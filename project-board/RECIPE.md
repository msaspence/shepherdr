# project-board

A mod: a whiteboard of the shown space's project tasks, from the provider that space is configured with
(only Notion so far: a Tech Tasks database's In progress, Queued, and Done-until-Released tasks).
Cards are draggable, "Blocked by" relations are orthogonal arrows, the agents working each task hang
off its card as avatars, and recent agent-to-agent messages show as fading green curves.

## Placing it

`mod.json` adds a **Project Board** sidebar entry that opens it as a tab named "Board". It takes no props.

## Configuring a space

A space with no project shows a call to action: **Set up project board** opens the setup dialog
(`setup.js`, this mod with props `{ variant: "setup", space, spaceName }`). It lists the providers; picking
one runs its `connect` (Notion: `notion-login.py`, OAuth in the browser on `localhost:8765`, the token saved
per space in `~/.config/herdr-app/data/project-board/tokens/`), then its `projects` (Notion: the databases
shared while connecting). With exactly one there's nothing to pick. The choice is saved, and the board reloads
at once (the dialog bumps `shared("project-board.config-rev")`).

Saved in `~/.config/herdr-app/data/project-board/spaces.json`, by space id, hand-editable:

```json
{ "sp3f6f…": { "provider": "notion", "tokenFile": "…", "assignee": "<Notion user id>", "dataSource": "<data source id>" } }
```

The board follows the shown space (it's on screen only in its own space), and re-reads the file every minute.

## Providers

`providers/index.js` lists the providers and documents the contract: `load({ config, onBoard })` resolves to tasks
in one shape (`id`, `key`, `title`, `icon`, `status { name, stage }`, `rank`, `people`, `blockedBy`,
`url`), plus `name`, `icon`, `setupHint`, `open(task)` and an optional `check()` for `herdr-app check`.
Everything else (layout, arrows, agents, PR checks) works from that shape. To add an integration, write
`providers/<name>.js` like `notion.js` and add it to `providers`.

## Setup

- **Notion:** `~/.config/notion-board/client.json` holds the public integration's `client_id` and
  `client_secret`, with `http://localhost:8765/callback` as its redirect URI. A config without `tokenFile`
  reads `~/.config/notion-board/token` (where `notion-login.py` saves when run by hand).
- **Agents:** a card's dotted avatar starts a herdr-chat tab named after the task, in the space's folder,
  with the task ID typed into the composer.
  Agents are matched to tasks by the task ID in their pane, tab, title, branch or space name.
- **PR checks:** `gh pr list` every 30s; the avatar ring shows failed / running / passed.
- **Message curves:** `log-link.sh` is a Claude Code PostToolUse hook (matcher `SendMessage`) that
  appends to `/tmp/herdr-agent-links.jsonl`; the board tails it every 5s.

## State

Shared keys `project-board.pos` (card positions), `.view` (pan and zoom), `.sessions` (each task's
last chat session, so a closed one can be resumed), `.grid-frozen`. Avatars and Lucide icons download
into the mod's `.cache/`. On first load it copies any old `notion-board.*` keys.

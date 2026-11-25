# project-board

A mod: a whiteboard of the shown space's project tasks, from the provider that space is configured with
(only Notion so far: a Tech Tasks database's In progress, Queued, and Done-until-Released tasks).
Cards are draggable, "Blocked by" relations are orthogonal arrows, the agents working each task hang
off its card as avatars, and recent agent-to-agent messages show as fading green curves.

## Placing it

`mod.json` adds a **Project Board** sidebar entry that opens it as a tab named "Board". It takes no props.

## Configuring a space

Each space's project lives in `~/.config/herdr-app/data/project-board/spaces.json`, by space id (`herdr-app ls`):

```json
{ "sp3f6f…": { "provider": "notion", "dataSource": "<data source id>", "assignee": "<Notion user id>" } }
```

`provider` names one in `providers/index.js`; the rest is that provider's settings. A space with no entry
shows "No project for <space>" with its id. The board follows the shown space (it's on screen only in its
own space), and re-reads the file on every refresh.

## Providers

`providers/index.js` lists the providers and documents the contract: `load({ config, onBoard })` resolves to tasks
in one shape (`id`, `key`, `title`, `icon`, `status { name, stage }`, `rank`, `people`, `blockedBy`,
`url`), plus `name`, `icon`, `setupHint`, `open(task)` and an optional `check()` for `herdr-app check`.
Everything else (layout, arrows, agents, PR checks) works from that shape. To add an integration, write
`providers/<name>.js` like `notion.js` and add it to `providers`.

## Setup

- **Notion:** `~/.config/notion-board/client.json` holds the public integration's `client_id` and
  `client_secret`. Run `notion-login.py` once: it opens Notion's consent page and writes the token to
  `~/.config/notion-board/token`, which the board reads every 60s.
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

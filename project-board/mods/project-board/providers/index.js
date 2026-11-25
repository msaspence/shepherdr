// Where the board's tasks come from. Each space picks one by name in ~/.config/herdr-app/data/project-board/spaces.json,
// written by the setup dialog (setup.js).
// To add an integration, write providers/<name>.js exporting an object like notion.js's, and list it below.
//
// A provider:
//   name        shown in errors ("Couldn't refresh from <name>") and the setup dialog
//   icon        an svg path for the card's "open in" button and the setup dialog
//   description one line under its name in the setup dialog
//   setupHint   shown under the error when nothing has loaded yet
//   load({ config, onBoard })  resolves to the tasks to show (throws on failure); config: the space's entry in
//               spaces.json; onBoard: Set of task keys already on the board
//   open(task)  opens the task in its app
//   connect({ space })  signs in (OAuth in the browser, say); resolves to the config so far, which it may store
//               a credential for (a token file per space, say)
//   projects(config)  resolves to [{ id, name, unusable? }]: what the board could show (Notion: databases), with
//               unusable saying why one can't be picked (shown, greyed out); the ids
//               picked are saved as the space's config.projects, which load reads
//   check()     optional, run under `herdr-app check`; throws if the provider's mapping is wrong
//
// A task:
//   id          the provider's id; what blockedBy refers to
//   key         a short ID like "OI-42": positions and sessions are saved by it, and agents are matched to it
//   title
//   icon        { emoji } | { svg: url, color?: theme key like "ansi1" } | null
//   status      { name, stage: "queued" | "progress" | "done" } | null: the pill on the card
//   rank        [number, number]: sort order, lowest first; new cards are placed in this order
//   people      [{ id, name, avatar?: url }]
//   blockedBy   [id]
//   url
import notion from "./notion.js";

export const providers = { notion };

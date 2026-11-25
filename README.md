# shepherdr

Layouts and mods for [Herdr](https://herdr.dev). Each folder is one gallery entry, laid out like a Herdr
home (`layouts/`, `mods/`), with a `RECIPE.md` (the brief another agent can build it from) and a
`preview.png`.

| Entry | What it is |
|---|---|
| [agents-sidebar](agents-sidebar/) | A layout: spaces and the active space's agents in one collapsible sidebar, the selected agent's chat filling the window. |
| [opens-in](opens-in/) | A mod: open a folder in the apps you choose (Finder, editors, terminals), as icons, a list or a dropdown button. |

## Installing an entry

Ask your agent to add it from `herdr.dev/layouts/msaspence/<entry>`, or by hand:

1. Copy the entry's `layouts/*.json` (and its `.svg`) into `~/.config/herdr-app/layouts/` and each folder
   under `mods/` into `~/.config/herdr-app/mods/`.
2. Merge the entry's `keys.json` into yours.
3. Run `herdr-app check ~/.config/herdr-app/mods/<mod>` for each mod, then switch to the layout with
   `herdr-app do layout.switch --name <layout>` (or the layout switch key, Ctrl+Shift+L by default).

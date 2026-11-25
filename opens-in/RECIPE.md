# opens-in

A mod that opens a folder in one of the apps the person chose (Finder, an editor, a terminal, a git
client). Drop it into any layout block. macOS only: it reads apps and their icons with `osascript` and
opens with `open -a`.

## Placing it

`{ "mod": "opens-in", "props": { "variant": "...", "path": "..." } }`

- `variant`:
  - `horizontal-icons`: a row of app icons, right-aligned (title bars).
  - `vertical-icons-text`: a column of icon and name rows.
  - `button-icon`: an external-link button whose dropdown lists the apps.
  - `button-text`: the same button reading "Open In".
- The folder: `path`, or `path_shared` naming a `shared()` key that holds one (it follows that key
  live). For example, the agents-sidebar layout passes `"path_shared": "agents-sidebar.active-cwd"`.
  With no folder, the apps are dimmed.
- Controls stop their mouse-down, so it works inside a `window_drag` bar.

## Choosing apps

The palette's **Open In: choose apps** (`mod.open {name: "opens-in"}`) opens the settings dialog. It lists
the presets in `PRESETS` that are installed in `/Applications`, `~/Applications` or the system app
folders, all off by default. Each has a switch and a grip handle: dragging it reorders the apps, and every
variant lists them in that order. **Add application…** opens the file picker. Picked
`.app` bundles are added switched on and can be removed with their ×. With nothing switched on, every
variant shows one "Choose apps…" item that opens the dialog.

Names are the Finder's display names, and icons are the app's own (`NSWorkspace.iconForFile`), cached
as PNGs in `~/.config/herdr-app/data/opens-in/icons/`. The choices live in
`shared("opens-in.apps")`: `[{ path, name, on, custom }]`, in the dialog's order. The dialog
re-detects apps each time it opens, so uninstalled ones drop out then. Saved apps keep their place, and
newly found ones go to the end.

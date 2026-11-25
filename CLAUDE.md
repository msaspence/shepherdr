# shepherdr

Herdr layouts and mods (see README.md). Herdr's own docs: `~/.config/herdr-app/AGENTS.md` and the
generated `herdr.d.ts` / `gpui-kit.d.ts` next to each mod.

## Git

Commit and push straight to `main`; no feature branches or PRs needed.

## Local dev setup

The entries' `layouts/*` and `mods/*` are symlinked into `~/.config/herdr-app/{layouts,mods}`, so the app
runs this repo's files directly.

**Hot reload does not follow symlinks.** Saving a file here does not reload the mod, and
`herdr-app status` reports no error, so a change can look broken when it never loaded. After editing,
touch the link itself:

```sh
touch -h ~/.config/herdr-app/mods/<mod-name>
```

## Verifying a change

- `herdr-app check ~/.config/herdr-app/mods/<mod-name>`: loads and renders the mod once, exits nonzero on error.
- `herdr-app status`: what the window shows, plus any mod errors.
- `herdr-app shot <file.png>`: screenshot the window. Check it in the real app, not just `check`.

These talk to the app over `~/.config/herdr-app/herdr-app.sock`, which the Claude Code sandbox blocks
("Operation not permitted"), so run them outside the sandbox. The sandboxed and unsandboxed `$TMPDIR`
differ, so write screenshots to a fixed path.

## Mod conventions

- Mods share state with `shared()` / `setShared()` using `agents-sidebar.*` keys.
  `setShared` re-renders every mod, so only call it from `render()` when the value changed.
  For example, `agents-sidebar-agents` publishes the selected row's name as `agents-sidebar.active-title`
  for the title bar.
- Truncated text in a row: `div().flex_1().min_w(0).truncate()`.
- Mods with a `props.peek` copy (drawer spacers) should skip content meant only for the main copy.

// opens-in: open a folder in one of the apps the person chose (an editor, Finder, a terminal).
// props.variant: "horizontal-icons" | "vertical-icons-text" | "button-icon" | "button-text" for a list or button;
// "menu" is the buttons' dropdown, and no variant (the palette's mod.open) is the settings dialog.
// The folder: props.path, else the shared value props.path_shared names (e.g. "agents-sidebar.active-cwd").
// Chosen apps live in shared("opens-in.apps"): [{ path, name, on, custom }], in the dialog's order. macOS only.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, ScrollHandle } from "gpui-base";
import { appHome, checking, closeOverlay, exec, home, notify, openOverlay, pickFiles, props, setShared, settings, shared, theme } from "herdr";

const KEY = "opens-in.apps";
const ICONS = "data/opens-in/icons"; // under appHome(), where image() looks

// Offered when installed; all start off.
const PRESETS = [
  "Finder", "Terminal", "iTerm", "Ghostty", "Warp", "WezTerm", "kitty", "Alacritty",
  "Visual Studio Code", "Visual Studio Code - Insiders", "Cursor", "Windsurf", "Zed", "Antigravity", "Kiro",
  "Sublime Text", "Nova", "BBEdit", "TextMate", "Xcode", "Android Studio",
  "IntelliJ IDEA", "IntelliJ IDEA CE", "WebStorm", "PyCharm", "PyCharm CE", "RubyMine", "GoLand", "PhpStorm",
  "RustRover", "CLion", "Fleet",
  "Fork", "Tower", "GitHub Desktop", "Sourcetree", "GitKraken", "Sublime Merge",
];
const DIRS = ["/Applications", "~/Applications", "/System/Applications", "/System/Applications/Utilities", "/System/Library/CoreServices"];

const ROW = 36, STEP = 38; // the dialog's rows, and row plus gap
const SLIDE = { duration: 160, easing: "ease-out" };
const EDGE = 36; // px from the list's top or bottom where a drag scrolls it
const END = 8; // room under the last row
const MARK = 2; // the list's scroll steps: scroll_to_item is the only way to move it, so it's made of thin markers
const marks = (n) => Math.ceil((n * STEP + END) / MARK);

const slug = (p) => p.replace(/[^A-Za-z0-9]+/g, "-");
const iconOf = (app) => `${ICONS}/${slug(app.path)}.png`;

// Run by osascript: argv[0] the icon folder, the rest app paths. Prints the ones that exist as
// [{ path, name }] (the Finder's name for each), writing each one's icon to <folder>/<slug>.png once.
const PROBE = `ObjC.import('AppKit');
const slug = ${slug.toString()};
function run(argv) {
  const fm = $.NSFileManager.defaultManager, ws = $.NSWorkspace.sharedWorkspace;
  const dir = argv[0];
  fm.createDirectoryAtPathWithIntermediateDirectoriesAttributesError(dir, true, $(), $());
  const out = [];
  for (const path of argv.slice(1)) {
    if (!fm.fileExistsAtPath(path)) continue;
    const name = fm.displayNameAtPath(path).js.replace(/\\.app$/, '');
    const png = dir + '/' + slug(path) + '.png';
    if (!fm.fileExistsAtPath(png)) {
      const img = ws.iconForFile(path);
      img.size = $.NSMakeSize(32, 32);
      const rep = $.NSBitmapImageRep.alloc.initWithCGImage(img.CGImageForProposedRectContextHints($(), $(), $()));
      rep.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $()).writeToFileAtomically(png, true);
    }
    out.push({ path, name });
  }
  return JSON.stringify(out);
}`;

async function probe(paths) {
  const r = await exec("osascript", ["-l", "JavaScript", "-e", PROBE, `${appHome()}/${ICONS}`, ...paths]);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "osascript failed");
  return JSON.parse(r.stdout);
}

const apps = () => shared(KEY) ?? [];

function openSettings() {
  openOverlay({ mod: "opens-in", kind: "dialog", width: 440, height: 520, props: { variant: "settings" } });
}

async function openIn(app, path) {
  try {
    const r = await exec("open", ["-a", app.path, path]);
    if (r.code !== 0) throw new Error(r.stderr.trim());
  } catch (e) {
    notify({ title: `Couldn't open in ${app.name}`, body: String(e.message ?? e), level: "error" });
  }
}

export default class OpensIn extends View {
  init(_props, cx) {
    this.variant = props()?.variant ?? "settings";
    if (this.variant !== "settings") return;
    this.scroll = ScrollHandle.new();
    cx.timer.every(16, (cx) => this.edgeScroll(cx));
    if (!checking()) this.refresh(cx);
  }

  path() {
    const p = props() ?? {};
    return p.path ?? (p.path_shared ? shared(p.path_shared) : null) ?? null;
  }

  // Finds installed presets (and the person's added apps), keeping each one's on/off.
  refresh(cx) {
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const custom = apps().filter((a) => a.custom).map((a) => a.path);
        const presets = PRESETS.flatMap((n) => DIRS.map((d) => `${d.replace(/^~/, home())}/${n}.app`));
        const found = await probe([...new Set([...presets, ...custom])]);
        const prev = new Map(apps().map((a, i) => [a.path, { ...a, i }]));
        // The person's order first; newly found apps after, in preset order.
        const next = found.map((f) => ({ ...f, on: prev.get(f.path)?.on ?? false, custom: prev.get(f.path)?.custom ?? false }))
          .sort((x, y) => (prev.get(x.path)?.i ?? 1e9) - (prev.get(y.path)?.i ?? 1e9));
        if (JSON.stringify(next) !== JSON.stringify(apps())) setShared(KEY, next);
      } catch (e) {
        this.error = String(e.message ?? e);
      }
      this.loading = false;
      cx.notify();
    });
  }

  add(cx) {
    cx.spawn(async (cx) => {
      const picked = ((await pickFiles({ prompt: "Add", multiple: true })) ?? []).filter((p) => p.endsWith(".app"));
      if (!picked.length) return;
      try {
        const found = await probe(picked);
        const list = apps().map((a) => (found.some((f) => f.path === a.path) ? { ...a, on: true } : a));
        for (const f of found) if (!list.some((a) => a.path === f.path)) list.push({ ...f, on: true, custom: true });
        setShared(KEY, list);
      } catch (e) {
        this.error = String(e.message ?? e);
      }
      cx.notify();
    });
  }

  render(cx) {
    const t = theme();
    if (this.variant === "settings") return this.settings(t);
    const on = apps().filter((a) => a.on);
    const path = this.path();
    const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation()); // the title bar is a window drag
    const act = (app) => () => {
      if (this.variant === "menu") closeOverlay(props().overlay);
      if (app) openIn(app, path); else openSettings();
    };
    const pic = (app, size) => (app
      ? image(iconOf(app)).size(size).flex_none()
      : svg("mods/opens-in/settings.svg").size(size - 2).flex_none().text_color(t.muted));
    const label = (app) => (app ? app.name : "Choose apps…");
    // No apps chosen: one item that opens the settings.
    const items = on.length ? on : [null];
    const live = (app) => !app || Boolean(path);

    if (this.variant === "horizontal-icons") {
      return h_flex().size_full().px(8).gap(2).items_center().justify_end()
        .children(items.map((app, i) => stop(div().id(`app-${i}`).size(26).flex_none().flex().items_center().justify_center().rounded(6)
          .when(live(app), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(act(app)))
          .when(!live(app), (el) => el.opacity(0.4))
          .tooltip(app ? `Open in ${app.name}` : "Choose apps to open folders in")
          .child(pic(app, 16)))));
    }

    if (this.variant === "vertical-icons-text" || this.variant === "menu") {
      const menu = this.variant === "menu";
      return v_flex().size_full().p(menu ? 5 : 4).gap(2).text_size(12.8).text_color(t.foreground)
        .when(menu, (el) => el.bg(t.popover)).overflow_y_scrollbar()
        .children(items.map((app, i) => stop(h_flex().id(`app-${i}`).h(30).px(8).gap(9).rounded(7).items_center().flex_none()
          .when(live(app), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(act(app)))
          .when(!live(app), (el) => el.opacity(0.4))
          .child(pic(app, 18)).child(div().flex_1().min_w(0).truncate().child(label(app))))));
    }

    // button-icon / button-text: a button whose dropdown is this mod's "menu".
    const text = this.variant === "button-text";
    const drop = () => {
      const b = this.bounds;
      openOverlay({ mod: "opens-in", kind: "popup", props: { variant: "menu", path },
        ...(b ? { at: { x: b.x + b.width - 220, y: b.y + b.height + 4 } } : { at: "pointer" }),
        width: 220, height: Math.min(400, 12 + items.length * 32) });
    };
    return h_flex().size_full().px(8).items_center().justify_end()
      .child(div().id("open-in").h(26).px(text ? 8 : 0).when(!text, (el) => el.w(26).justify_center())
        .flex().flex_none().gap(6).items_center().rounded(6).cursor_pointer()
        .text_size(12.8).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); if (e.bounds) this.bounds = e.bounds; })
        .on_click(drop)
        .child(svg("mods/opens-in/external-link.svg").size(14).flex_none())
        .when(text, (el) => el.child("Open In").child(svg("mods/opens-in/chevron-down.svg").size(12).flex_none())));
  }

  // The order with the dragged app in the slot nearest the pointer.
  dragOrder() {
    const d = this.drag, list = apps();
    const rest = list.filter((a) => a.path !== d.path);
    const to = Math.max(0, Math.min(rest.length, Math.round(d.y / STEP)));
    rest.splice(to, 0, list.find((a) => a.path === d.path));
    return rest;
  }

  // Pointer and bounds are window px; layout px are those over the zoom. drag.y is the held row's top in
  // the list's content, so it stays under the pointer while the list scrolls.
  startDrag(app, e, cx) {
    cx.stop_propagation();
    if (!e.bounds) return;
    const z = settings().zoom ?? 1;
    const i = apps().findIndex((a) => a.path === app.path);
    const rowTop = e.bounds.y - ((ROW - e.bounds.height / z) / 2) * z; // the grip is centred in its row
    const top = rowTop - (i * STEP - this.scroll.offset().y) * z; // the list's top on screen
    this.drag = { path: app.path, grab: e.position.y - rowTop, top, py: e.position.y, y: i * STEP };
    cx.notify();
  }

  dragY() {
    const d = this.drag, z = settings().zoom ?? 1;
    const max = (apps().length - 1) * STEP;
    return Math.max(-STEP / 2, Math.min(max + STEP / 2, (d.py - d.grab - d.top) / z + this.scroll.offset().y));
  }

  moveDrag(e, cx) {
    if (!this.drag) return;
    if (e.pressed_button !== "left") return this.endDrag(cx);
    this.drag.py = e.position.y;
    this.drag.y = this.dragY();
    cx.notify();
  }

  // Near an edge, a frame at a time: up to 12px a frame, faster the closer the pointer is to (or past) the edge.
  edgeScroll(cx) {
    const d = this.drag;
    if (!d) return;
    const z = settings().zoom ?? 1;
    const at = (d.py - d.top) / z, off = this.scroll.offset().y, vh = this.scroll.viewport_size().height;
    const steps = (depth) => Math.max(1, Math.round((Math.min(EDGE, depth) / EDGE) * 6));
    if (at < EDGE && off > 0) this.scroll.scroll_to_item(Math.max(0, Math.ceil(off / MARK) - steps(EDGE - at)));
    else if (at > vh - EDGE && off + vh < this.scroll.content_size().height - 1)
      this.scroll.scroll_to_item(Math.min(marks(apps().length) - 1, Math.floor((off + vh) / MARK) + steps(at - vh + EDGE) - 1));
    else return;
    d.y = this.dragY();
    cx.notify();
  }

  endDrag(cx) {
    if (!this.drag) return;
    const order = this.dragOrder();
    this.drag = null;
    if (order.some((a, i) => a.path !== apps()[i]?.path)) setShared(KEY, order);
    cx.notify();
  }

  settings(t) {
    // While a handle is dragged, the dragged row follows the pointer and the rest slide around its slot;
    // the release saves the order.
    const list = apps();
    const slot = new Map((this.drag ? this.dragOrder() : list).map((a, i) => [a.path, i]));
    const set = (path, patch) => setShared(KEY, apps().map((a) => (a.path === path ? { ...a, ...patch } : a)));
    const toggle = (app) => div().id(`toggle-${slug(app.path)}`).w(30).h(18).p(2).flex().flex_none().rounded(9).cursor_pointer()
      .bg(app.on ? t.accent : t.border).when(app.on, (el) => el.justify_end())
      .on_click(() => set(app.path, { on: !app.on }))
      .child(div().size(14).rounded(7).bg("#ffffff"));
    const button = (id, label, primary, onClick) => div().id(id).h(28).px(12).flex().items_center().rounded(7).cursor_pointer()
      .text_size(12.8).when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .on_click(onClick).child(label);
    return v_flex().id("settings").size_full().bg(t.popover)
      .on_window_mouse_up("left", (_e, cx) => this.endDrag(cx))
      .on_mouse_move((e, cx) => this.moveDrag(e, cx))
      .when(Boolean(this.drag), (el) => el.cursor_grabbing())
      .text_color(t.foreground).text_size(13)
      .child(v_flex().px(18).pt(16).pb(10).gap(3).flex_none()
        .child(div().text_size(15).child("Open In"))
        .child(div().text_size(12).text_color(t.muted).child("Choose the apps folders can open in. Only installed apps are listed.")))
      .when(this.loading && !list.length, (el) => el.child(div().px(18).py(8).flex_none().text_color(t.muted).child("Looking for apps…")))
      .when(Boolean(this.error), (el) => el.child(div().px(18).py(8).flex_none().text_color(t.blocked).child(this.error)))
      // Thin invisible markers give the list its height (every slot and the room under the last) and edgeScroll its
      // steps; the rows are drawn over them, each at its slot's top, so a new slot slides. The held row is last, on top.
      .child(v_flex().id("apps").relative().flex_1().min_h(0).overflow_y_scrollbar().track_scroll(this.scroll)
        .children(Array.from({ length: marks(list.length) }, (_v, i) => div().id(`mark-${i}`).h(MARK).flex_none()))
        .child(div().absolute().top(0).left(10).right(10).h(list.length * STEP)
          .children([...list].sort((a, b) => (a.path === this.drag?.path) - (b.path === this.drag?.path)).map((app) => {
            const held = this.drag?.path === app.path;
            return h_flex().id(`row-${slug(app.path)}`).absolute().left(0).w_full().h(ROW).pl(2).pr(8).gap(8).rounded(7).items_center()
          .top(held ? this.drag.y : slot.get(app.path) * STEP)
          .when(!held, (el) => el.transition("top", SLIDE))
          .when(held, (el) => el.bg(t.raised).shadow_lg())
          .when(!this.drag, (el) => el.hover((s) => s.bg(t.hover)))
          .child(div().id(`grip-${slug(app.path)}`).w(16).h(28).flex().flex_none().items_center().justify_center().rounded(4)
            .text_color(t.dim).when(!this.drag, (el) => el.cursor_grab().hover((s) => s.text_color(t.foreground))).tooltip("Drag to reorder")
            .on_mouse_down("left", (e, cx) => this.startDrag(app, e, cx))
            .child(svg("mods/opens-in/grip-vertical.svg").size(14)))
          .child(image(iconOf(app)).size(20).flex_none())
          .child(h_flex().flex_1().min_w(0).gap(8).items_center()
            .child(div().flex_none().child(app.name))
            .when(app.custom, (el) => el.child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim)
              .child(app.path.replace(home(), "~")))))
          .when(app.custom, (el) => el.child(div().id(`remove-${slug(app.path)}`).size(20).flex().flex_none().items_center().justify_center()
            .rounded(5).cursor_pointer().text_color(t.dim).hover((s) => s.bg(t.raised).text_color(t.foreground)).tooltip("Remove")
            .on_click(() => setShared(KEY, apps().filter((a) => a.path !== app.path)))
            .child(svg("mods/opens-in/x.svg").size(12))))
          .child(toggle(app));
          }))))
      .child(h_flex().px(18).py(12).gap(8).flex_none().border_t_1().border_color(t.border)
        // The click's own cx: render's is gone by the time the button is pressed.
        .child(button("add", "Add application…", false, (_e, cx) => this.add(cx)))
        .child(div().flex_1())
        .child(button("done", "Done", true, () => closeOverlay(props().overlay))));
  }
}

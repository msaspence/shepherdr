// The agents-sidebar layout's agents panel: the agents list (agents-base.js) plus, above it, items other
// mods register in their mod.json: `"sidebar": [{ "title", "icon", "tab": { "name", "props"? } }]` opens
// that mod as a named tab in the active space (selecting it if there is one already), or
// `{ "title", "icon", "command", "args"? }` runs an app command. After the agents, New agent: one
// installed harness starts it, several open a menu to pick one. At the base, Settings and Add machine.
// It also runs the sidebar: the rail <-> expanded toggle, the hover drawer, and the edge and split drags.

import Agents, { RAIL, toggleSidebar } from "./agents-base.js";
import { div, image, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { appHome, checking, closeOverlay, focused, updates, settings, knownAgents, layout, nextCommand, openOverlay, panes, props, run, setShared, shared, spaces, terminals, theme } from "herdr";
import { readdir, readFile } from "fs/promises";
import { dragCursor, drawerFade, drawerHover, hasMod, loadMods, menuMod, sidebarIdle } from "./drawer.js";

let shown = null; // the chat dialog this list opened last
let items = []; // registered sidebar items, every copy's

// The last agents each machine reported (new-menu's key, so both menus warm each other).
const KNOWN = "new-menu.agents";
// With herdr-chat installed, these start as its GUI chat (new-chat's commands); otherwise, and for the rest
// and other machines' spaces, they run as terminals.
const CHAT = new Set(["claude", "codex", "pi"]);
const startAgent = (a, space) => CHAT.has(a.key) && !space?.machine && hasMod("new-chat")
  ? (setShared(NEW_CHAT, { at: Date.now(), from: chatPanes() }), run(`new-chat.${a.key}`))
  : run("tab.new", { name: a.name, space: space?.id, argv: a.run, ...(space ? { folder: shared("space.dirs")?.[space.id] ?? space.folder } : {}) });
// A new chat focuses its composer before Herdr hands its pane the keyboard, then retries 400 ms later.
// The chat panes that existed before it started, so the main copy's render can hand it the keyboard on arrival.
const NEW_CHAT = "agents-sidebar.new-chat";
const chatPanes = () => panes().filter((p) => p.mod === "chat").map((p) => p.pane);
function focusNewChat() {
  const want = shared(NEW_CHAT);
  if (!want) return;
  const late = Date.now() - want.at > 5000; // it never came; don't grab some later chat
  const fresh = !late && panes().find((p) => p.mod === "chat" && p.focused && !want.from.includes(p.pane));
  if (!fresh && !late) return;
  setShared(NEW_CHAT, null);
  if (fresh) run("chat.focus");
}
const installed = () => (shared(KNOWN)?.[spaces().find((s) => s.active)?.machine ?? ""] ?? []).filter((a) => a.installed);

async function loadItems() {
  await loadMods();
  const dir = `${appHome()}/mods`;
  const out = [];
  for (const mod of (await readdir(dir).catch(() => [])).sort()) {
    try {
      const m = JSON.parse(await readFile(`${dir}/${mod}/mod.json`, "utf8"));
      for (const it of Array.isArray(m.sidebar) ? m.sidebar : []) if (it?.title) out.push({ ...it, mod, key: `${mod}:${it.title}` });
    } catch {}
  }
  items = out;
}

// The item's tab: named for it and showing its mod, so a same-named tab left from another mod isn't picked.
const itemTab = (it, space) => it.tab && space?.tabs.find((tab) => tab.named && tab.name === it.tab.name
  && panes().some((p) => p.tab === tab.id && p.mod === it.mod));
function openItem(it) {
  const space = spaces().find((s) => s.active);
  if (!it.tab) return run(it.command, it.args ?? {});
  const tab = itemTab(it, space);
  if (tab) run("tab.select", { id: tab.id });
  else run("tab.new", { name: it.tab.name, space: space?.id, mod: it.mod, ...(it.tab.props ? { props: it.tab.props } : {}) });
}

function newAgent() {
  const list = installed();
  const space = spaces().find((s) => s.active);
  if (list.length === 1) return startAgent(list[0], space);
  openOverlay({ mod: "agents-sidebar-agents", kind: "popup", width: 220, height: 10 + Math.max(1, list.length) * 31, props: { harness: true } });
}

// The sidebar drawer: the layout's sidebar, copied with props.peek on each block, in a frameless
// window over the work area, as wide as the sidebar was before it folded.
function findNode(n, id) {
  if (n?.id === id) return n;
  for (const c of n?.children ?? []) { const f = findNode(c, id); if (f) return f; }
  return null;
}
// Narrower than this the sidebar is the rail. Dragging its edge (drag) never stops between the two.
const EXPANDED_MIN = 160;
const MAX_WIDTH = 480;
// Dragging the edge: from the rail it expands once the pointer passes RAIL + EXPAND_PAST; expanded, it
// holds at EXPANDED_MIN until the pointer is back within RAIL + COLLAPSE_WITHIN. The gap between the two
// keeps it from flipping back and forth.
const EXPAND_PAST = 16;
// The spaces block's layout min, and how often a split drag redraws the drawer.
const SPLIT_MIN = 40;
const SPLIT_FRAME = 50;
const SPLIT_OVERLAP = 35;
const COLLAPSE_WITHIN = 8;
const sidebarWidth = () => findNode(layout(), "sidebar")?.size?.px ?? Infinity;
const railed = () => sidebarWidth() < EXPANDED_MIN;
const peekCopy = (n) => ({
  ...n, id: `peek-${n.id}`,
  ...(n.content?.mod ? { content: { ...n.content, props: { ...n.content.props, peek: true } } } : {}),
  ...(n.children ? { children: n.children.map(peekCopy) } : {}),
});
// No divider in the drawer: a visible one would cross the whole window while the drawer is still
// rail-wide, and a transparent one is a gap the chat shows through. The agents block draws the line.
const drawerTree = ({ divider, ...n }) => (n.children ? { ...n, children: n.children.map(drawerTree) } : n);
function openDrawer(key = "sidebar-drawer") {
  const side = findNode(layout(), "sidebar");
  if (!side || side.hidden || !railed()) return null;
  // No background: each block draws its own as it slides in (drawer.js).
  // Over the title bar too, whose spacer (agents-sidebar-titlebar's peek copy) keeps the toggle where it was.
  const { size, min, max, background, ...tree } = drawerTree(peekCopy(side));
  const bar = findNode(layout(), "titlebar");
  const layoutTree = { id: "peek-root", type: "column", children: [
    { id: "peek-titlebar", type: "block", size: bar?.size ?? { px: 42 }, content: { mod: "agents-sidebar-titlebar", props: { peek: true } } },
    tree,
  ] };
  return openOverlay({ kind: "window", key, frame: "none", at: { x: 0, y: 0 },
    width: shared("agents-sidebar.width") ?? 268, height: 1, layout: layoutTree });
}

// Drawer windows a reload left behind: nothing tracks their ids any more, so they'd never close. Opening a
// key again replaces its window, so each is replaced by an empty one that closes straight away.
const DRAWER_KEYS = ["sidebar-drawer", "sidebar-drawer-b", "sidebar-drawer-c"];
function closeStrayDrawers() {
  for (const key of DRAWER_KEYS) closeOverlay(openOverlay({ kind: "window", key, frame: "none", at: { x: 0, y: 0 }, width: 1, height: 1, layout: { id: `stray-${key}`, type: "column", children: [] } }));
  setShared("agents-sidebar.drawer.closing", null);
  setShared("agents-sidebar.drawer.instant", false);
}

export function openChatPeek(addr) {
  const t = terminals().find((x) => x.address === addr);
  const chat = t?.labels?.["herdr-chat.chat"];
  if (!chat) return false;
  run("overlay.close", { id: "terminal-peek" });
  if (shown) closeOverlay(shown);
  const provider = t.labels["herdr-chat.provider"];
  shown = openOverlay({ mod: "chat", kind: "dialog", width: 0.8, height: 0.8, props: { chat, peek: addr, ...(provider ? { provider } : {}) } });
  return true;
}

const popup = () => props()?.harness;

export default class SideAgents extends Agents {
  init(p, cx) {
    super.init(p, cx);
    if (popup()) return;
    // props(), not init's argument: a layout block's init doesn't get its props.
    const inDrawer = Boolean(props()?.peek);
    if (!inDrawer && !checking()) {
      setShared("agents-sidebar.dragging", false); // drags a reload cut short
      setShared("agents-sidebar.split-drag", false);
      closeStrayDrawers();
    }
    if (!checking()) {
      const refresh = (cx) => cx.spawn(async (cx) => { await loadItems(); cx.notify(); });
      refresh(cx);
      cx.timer.every(30000, refresh);
      const machine = spaces().find((s) => s.active)?.machine;
      cx.spawn(async (cx) => {
        try { setShared(KNOWN, { ...shared(KNOWN), [machine ?? ""]: await knownAgents({ on: machine }) }); } catch {}
        cx.notify();
      });
    }
    // agents-sidebar-agents.collapse: rail <-> expanded (the rail's copy; it also closes the drawer).
    // peek:<address>: open a sub-agent as its row would. menu:<address>: its right-click menu.
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "collapse") { if (!inDrawer) { if (this.drawerId) closeOverlay(this.drawerId); this.drawerId = null; toggleSidebar(); } }
        // open: open the drawer (a key can bind agents-sidebar-agents.open).
        else if (c === "open") { if (!inDrawer) this.openDrawerNow(); }
        // next/prev: agent.next/prev, but wrapping within the listed agents. Herdr appends unlisted
        // ones (archived, other spaces) after the published order, so agent.next runs into them.
        else if (c === "next" || c === "prev") { if (!inDrawer) this.step(c === "next" ? 1 : -1); }
        else if (c.startsWith("peek:")) this.peek(c.slice(5));
        else if (c.startsWith("menu:")) openOverlay({ mod: menuMod(), kind: "popup", width: 240, props: { tab: "pane", target: { terminal: c.slice(5) } } });
      }
    });
  }

  // Visiting a done agent makes it idle and re-sorts the list, so presses in quick succession
  // keep the order they started with; otherwise next could bounce back to one already seen.
  step(d) {
    const now = Date.now();
    const held = this.nav && now - this.nav.at < 2000 ? this.nav : null;
    const order = held?.order ?? (this.order ?? []).map((a) => a.address);
    const n = order.length;
    if (!n) return;
    // With a chat (mod) pane focused there's no focused agent: use its tab's, as the row highlight does.
    const f = focused();
    const cur = held?.addr ?? f?.agent ?? this.order.find((a) => a.tab === f?.tab)?.address;
    const i = order.indexOf(cur);
    const addr = order[i < 0 ? (d > 0 ? 0 : n - 1) : (i + d + n) % n];
    this.nav = { order, addr, at: now };
    run("pane.focus", { terminal: addr });
  }

  peek(addr) {
    if (!openChatPeek(addr)) super.peek(addr);
  }

  // The drawer follows the pointer anywhere in the window (the rail's copy sees every move): it opens
  // as soon as the pointer is on the rail and closes once it's past the drawer's width. Not near the rail's
  // dividers or with a button held, so the spaces/agents split and the sidebar's edge stay draggable.
  pointer(e, cx) {
    const zoom = settings().zoom ?? 1;
    const x = e.position.x / zoom, y = e.position.y / zoom;
    this.cursorLayer(e.pressed_button === "left" ? dragCursor() : null);
    if (shared("agents-sidebar.split-drag")) {
      if (e.pressed_button === "left") this.splitTo(y, cx);
      else this.endSplit(y, cx); // released outside the window
      return;
    }
    if (shared("agents-sidebar.dragging")) {
      if (e.pressed_button === "left") this.drag(x);
      else this.endDrag(); // released outside the window
      return;
    }
    if (this.drawerId) {
      const inside = x <= (shared("agents-sidebar.width") ?? 268);
      const closing = shared("agents-sidebar.drawer.closing") === this.drawerId;
      if (inside && closing) setShared("agents-sidebar.drawer.closing", null);
      else if (!inside && !closing) this.closeDrawer(this.drawerId, cx);
      return;
    }
    const split = e.bounds.y / zoom; // this block's top: the spaces/agents divider
    const bar = findNode(layout(), "titlebar")?.size?.px ?? 42;
    if (!railed() || e.pressed_button || x > RAIL - 6 || y < bar || Math.abs(y - split) < 6) return;
    this.openDrawerNow();
  }

  openDrawerNow() {
    if (this.drawerId || !railed()) return;
    setShared("agents-sidebar.drawer.instant", false);
    this.drawerKey = "sidebar-drawer";
    this.drawerId = openDrawer(this.drawerKey);
  }

  // Dragging the sidebar's edge (drawer.js's handle): the width follows the pointer but snaps between
  // the rail and EXPANDED_MIN as it goes.
  drag(x) {
    const w = sidebarWidth();
    const wide = Math.round(Math.min(MAX_WIDTH, Math.max(EXPANDED_MIN, x)));
    const target = w < EXPANDED_MIN ? (x > RAIL + EXPAND_PAST ? wide : RAIL) : (x < RAIL + COLLAPSE_WITHIN ? RAIL : wide);
    if (target === Math.round(w)) return;
    if (this.drawerId) { closeOverlay(this.drawerId); this.drawerId = null; }
    run("layout.resize", { id: "sidebar", px: target });
  }

  // Dragging the drawer's split (drawer.js's handle): the real spaces block follows the pointer, and the
  // drawer is redrawn at the new size, at most every SPLIT_FRAME ms. Each redraw is a new window, opened
  // on top under the other of two redraw keys; the previous redraw closes once the new one has painted
  // (SPLIT_OVERLAP, under SPLIT_FRAME), so there's never a frame without a drawer. The window the press
  // started in stays open underneath until the drag ends: closing it ends the drag's pointer events.
  splitTo(y, cx, force = false) {
    const bar = findNode(layout(), "titlebar")?.size?.px ?? 42;
    const h = Math.max(SPLIT_MIN, Math.round(y - bar));
    const now = Date.now();
    if (!force && (h === this.splitH || now - (this.splitAt ?? 0) < SPLIT_FRAME)) return;
    this.splitH = h;
    this.splitAt = now;

    run("layout.resize", { id: "spaces", px: h });
    if (this.drawerId) {
      setShared("agents-sidebar.drawer.instant", true);
      const old = this.drawerId;
      this.pressWindow ??= old;
      this.drawerKey = this.drawerKey === "sidebar-drawer-b" ? "sidebar-drawer-c" : "sidebar-drawer-b";
      this.drawerId = openDrawer(this.drawerKey) ?? old;
      if (this.drawerId !== old && old !== this.pressWindow) cx.timer.after(SPLIT_OVERLAP, () => closeOverlay(old));
    }
  }

  // A transparent full-window layer holding the drag's cursor while the pointer is off the sidebar (over
  // the chat). Drawer redraws open above it and hold the cursor themselves (drawer.js).
  cursorLayer(kind) {
    if (kind === this.cursorKind) return;
    if (this.cursorId) closeOverlay(this.cursorId);
    this.cursorId = kind ? openOverlay({ mod: "agents-sidebar-titlebar", kind: "window", key: "sidebar-drag-cursor", frame: "none",
      at: { x: 0, y: 0 }, width: 1, height: 1, props: { cursor: kind } }) : null;
    this.cursorKind = kind;
  }

  endSplit(y, cx) {
    if (!shared("agents-sidebar.split-drag")) return;
    if (y != null) this.splitTo(y, cx, true);
    setShared("agents-sidebar.split-drag", false);
    const press = this.pressWindow;
    this.pressWindow = null;
    if (press && press !== this.drawerId) cx.timer.after(SPLIT_OVERLAP, () => closeOverlay(press));
    this.splitH = null;
  }

  endDrag(e, cx) {
    this.cursorLayer(null);
    if (shared("agents-sidebar.split-drag")) return this.endSplit(e ? e.position.y / (settings().zoom ?? 1) : null, cx);
    if (!shared("agents-sidebar.dragging")) return;
    setShared("agents-sidebar.dragging", false);
    const w = sidebarWidth();
    if (w >= EXPANDED_MIN) setShared("agents-sidebar.width", w);
  }

  closeDrawer(id, cx) {
    setShared("agents-sidebar.drawer.closing", id);
    cx.timer.after(180, () => {
      if (shared("agents-sidebar.drawer.closing") !== id) return;
      closeOverlay(id);
      setShared("agents-sidebar.drawer.closing", null);
      setShared("agents-sidebar.drawer.instant", false);
      if (this.drawerId === id) this.drawerId = null;
    });
  }

  harnessMenu(t) {
    const list = installed();
    const space = spaces().find((s) => s.active);
    return v_flex().w_full().p(5).bg(t.popover).text_size(12.8)
      .when(!list.length, (el) => el.child(div().px(9).py(6).text_color(t.dim).child("Checking installed agents…")))
      .children(list.map((a) => h_flex().id(`harness-${a.key}`).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
        .text_color(t.foreground).hover((s) => (sidebarIdle() ? s.bg(t.hover) : s))
        .on_click(() => { closeOverlay(props().overlay); startAgent(a, space); })
        .child(a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14))
        .child(div().flex_1().child(a.name))));
  }

  // The item slot and New agent, above the list. Rail: icon cells.
  top(t, collapsed) {
    const space = spaces().find((s) => s.active);
    const activeTab = space?.tabs.find((tab) => tab.active)?.id;
    // The rail is the expanded row with its label hidden: same margin, padding and height.
    const row = (id, icon, label, on, click) => h_flex().id(id).h(30).px(8).gap(9).rounded(8).items_center().flex_none().cursor_pointer()
      .text_color(t.foreground)
      .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => (sidebarIdle() ? s.bg(t.hover) : s)))
      .when(collapsed, (el) => el.tooltip(label))
      .overflow_hidden()
      .on_click(click).child(icon).child(drawerFade(div().flex_1().min_w(0).truncate().child(label), true));
    const glyph = (path) => svg(path).size(15).flex_none().text_color(t.muted);
    return v_flex().flex_none().py(6).gap(2).px(8).text_size(13)
      .children(items.map((it) => row(`item-${it.key}`, it.icon ? glyph(it.icon) : div().w(15), it.title,
        Boolean(activeTab) && itemTab(it, space)?.id === activeTab, () => openItem(it))));
  }

  // After the agent rows (agents-base.js): New agent.
  extraRows(t, collapsed) {
    const plus = svg("mods/workspace-chrome/plus.svg").size(14).flex_none();
    return [h_flex().id("new-agent").h(30).mt(4).px(8).gap(9).rounded(8).items_center().flex_none().cursor_pointer()
      .text_color(t.muted).hover((s) => (sidebarIdle() ? s.bg(t.hover).text_color(t.foreground) : s))
      .when(collapsed, (el) => el.tooltip("New agent"))
      .on_click(() => newAgent()).child(h_flex().w(14).flex_none().justify_center().child(plus))
      .overflow_hidden()
      .child(drawerFade(div().child("New agent")))];
  }

  // The panel's base: the shipped sidebar footer's Settings and Add machine.
  footer(t, collapsed) {
    const row = (id, icon, label, dim, action) => h_flex().id(id).h(28).px(8).gap(9).items_center().rounded(8)
      .relative()
      .when(collapsed, (el) => el.tooltip(label))
      .text_color(dim ? t.dim : t.muted).hover((s) => (sidebarIdle() ? s.bg(t.hover).text_color(t.foreground) : s)).cursor_pointer()
      .on_click(action).child(svg(`mods/workspace-chrome/${icon}.svg`).size(14).flex_none())
      .overflow_hidden()
      .child(drawerFade(div().child(label)));
    const ready = div().size(6).rounded_full().bg(t.accent);
    return v_flex().flex_none().border_t(1).border_color(t.border).px(8).pt(4).pb(8).text_size(13)
      .child(row("settings", "settings", "Settings", false, () => run("app.settings"))
        .when(Boolean(updates()?.app?.ready), (el) => el.child(collapsed ? ready.absolute().top(5).right(6) : ready)))
      .child(row("machine", "plus", "Add machine", true, () => run("mod.open", { name: "machine-add" })));
  }

  render(cx) {
    const t = theme();
    if (props()?.harness) return this.harnessMenu(t);
    if (!props()?.peek) focusNewChat();
    const el = super.render(cx);
    // The rail draws the full panel under drawer.js's veil.
    const collapsed = false;
    return drawerHover(v_flex().id("agents-sidebar-agents-root").size_full().min_h(0).bg(t.chrome)
      .when(!props()?.peek, (el) => el.on_window_mouse_move((e, cx) => this.pointer(e, cx))
        .on_window_mouse_up("left", (e, cx) => this.endDrag(e, cx)))
      .child(this.top(t, collapsed))
      .child(v_flex().flex_1().min_h(0).child(el))
      .child(this.footer(t, collapsed)), { split: "agents" });
  }
}

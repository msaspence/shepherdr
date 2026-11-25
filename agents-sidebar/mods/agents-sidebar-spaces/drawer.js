// The sidebar's rail and drawer. Collapsed and expanded draw the same rows: the rail is the expanded
// sidebar at the rail's width with every label faded out (drawerFade) and each row clipped to itself,
// so switching fades labels in and out instead of swapping layouts. The drawer (props.peek, opened by agents-sidebar-agents when
// the pointer rests on the rail) starts the same way at the rail's width and grows to full width.
// The sidebar's right edge is a drag handle here (the layout's own resizing is off): agents-sidebar-agents snaps it.
// Copied into each sidebar mod's folder (a mod imports only its own files): keep the copies the same.
import { div } from "gpui-kit";
import { appHome, layout, props, setShared, shared, theme } from "herdr";
import { readdir } from "fs/promises";

// The mods installed in this Herdr home: herdr-chat's (chat-menu, new-chat) are used when present.
// loadMods() reads the folder; until then hasMod() is false, so the fallbacks apply.
const MODS = new Set();
export async function loadMods() {
  MODS.clear();
  for (const m of await readdir(`${appHome()}/mods`).catch(() => [])) MODS.add(m);
}
export const hasMod = (name) => MODS.has(name);
// The right-click menu for a space or terminal: herdr-chat's when installed (more items), else Herdr's.
export const menuMod = () => (hasMod("chat-menu") ? "chat-menu" : "menu");

// The rail's width (agents-base.js RAIL) and the width below which the sidebar is the rail
// (agents-sidebar-agents EXPANDED_MIN).
const RAIL = 46;
const EXPANDED_MIN = 160;
const OPEN = { duration: 200, easing: "ease-out" };
const CLOSE = { duration: 160, easing: "ease-in" };

function findNode(n, id) {
  if (n?.id === id) return n;
  for (const c of n?.children ?? []) { const f = findNode(c, id); if (f) return f; }
  return null;
}
const railed = () => (findNode(layout(), "sidebar")?.size?.px ?? Infinity) < EXPANDED_MIN;

// A drawer copy grows once it has been laid out at the rail's width (on_size_change), so the change
// animates. Keyed by props (overlay id included): one key per open.
const grown = new Set();
const keyOf = () => JSON.stringify(props() ?? {});
const closing = () => shared("agents-sidebar.drawer.closing") === props()?.overlay;

// Whether this copy shows what the rail hides: the sidebar is expanded, or this drawer copy has grown.
function showing() {
  return props()?.peek ? (grown.has(keyOf()) || Boolean(shared("agents-sidebar.drawer.instant"))) && !closing() : !railed();
}
const motion = () => (showing() ? OPEN : CLOSE);

// No drag of the sidebar's edge or the drawer's split in progress. Rows skip their hover highlight while
// one is: the drawer is redrawn under a still pointer, and a row at the pointer would flash on and off.
export const sidebarIdle = () => !shared("agents-sidebar.split-drag") && !shared("agents-sidebar.dragging");

// The drag's cursor, held over a panel's rows while a drag is on (rows would show their own pointer).
// agents-sidebar-agents opens a full-window layer with it too, for when the pointer leaves the sidebar.
export const dragCursor = () => (shared("agents-sidebar.split-drag") ? "row" : shared("agents-sidebar.dragging") ? "col" : null);
export function cursorCover(kind) {
  const d = div().id("drag-cursor").absolute().top(0).left(0).right(0).bottom(0);
  return kind === "row" ? d.cursor_row_resize() : d.cursor_col_resize();
}

// Fades `el` with the rail: every label the rail hides. `grow`: the wrapper takes the row's remaining
// width (flex_1, min_w 0) so what's inside still truncates.
export function drawerFade(el, grow = false) {
  return div().flex().items_center().when(grow, (d) => d.flex_1().min_w(0))
    .opacity(showing() ? 1 : 0).transition("opacity", motion()).child(el);
}

// The sidebar's right edge: pressing it starts a drag (agents-sidebar-agents follows the pointer). The line shows
// on hover in the input color and blue only while dragging.
const handle = (t) => {
  const dragging = Boolean(shared("agents-sidebar.dragging"));
  const hover = Boolean(shared("agents-sidebar.edge-hover"));
  return div().id("sidebar-edge").absolute().top(0).bottom(0).right(0).w(6).cursor_col_resize()
    .on_hover((h) => setShared("agents-sidebar.edge-hover", h))
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); setShared("agents-sidebar.dragging", true); })
    .child(div().absolute().top(0).bottom(0).right(0).w(1)
      .bg(dragging ? t.accent : hover ? t.input : "#00000000"));
};

// The spaces/agents split is drawn and dragged here, not by a layout divider: the drawer's dividers can't
// be dragged (a window overlay's don't), and the sidebar's would cross the edge handle's line. Pressing the
// handle starts a split drag (shared "agents-sidebar.split-drag"); agents-sidebar-agents' rail copy follows the pointer,
// resizing the layout's spaces block (and redrawing the drawer at the new size if it's open).

// `edge`: "bottom" on the spaces copy, "top" on the agents copy, so the handle straddles the visible line
// (the agents block's top border) instead of stopping just above it.
function splitHandle(t, edge) {
  const hover = Boolean(shared("agents-sidebar.split-hover"));
  const dragging = Boolean(shared("agents-sidebar.split-drag"));
  return div().id(`split-edge-${edge}`).absolute().left(0).right(0).h(6).cursor_row_resize()
    .when(edge === "bottom", (d) => d.bottom(0)).when(edge === "top", (d) => d.top(0))
    .on_hover((h) => setShared("agents-sidebar.split-hover", h))
    .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); setShared("agents-sidebar.split-drag", true); })
    // The split's line, over the panel's own background.
    .when(edge === "top", (d) => d.child(div().absolute().left(0).right(0).top(0).h(1)
      .bg(dragging ? t.accent : hover ? t.input : t.border)));
}

// `split`: "spaces" or "agents", the drawer block this is (each draws its half of the split handle).
export function drawerHover(el, { split = null } = {}) {
  const t = theme();
  const cursor = dragCursor();
  // The agents copy starts 1px down, under its own line (splitHandle): the sidebar has no layout divider
  // between spaces and agents, which would cross the edge handle's line.
  const body = split === "agents" ? div().size_full().pt(1).child(el) : el;
  if (!props()?.peek) return div().id("drawer-root").relative().size_full().overflow_hidden()
    .child(body)
    .when(Boolean(split), (d) => d.child(splitHandle(t, split === "spaces" ? "bottom" : "top")))
    // After the split handle, so the edge's line is on top where the two meet.
    .child(handle(t))
    .when(Boolean(cursor), (d) => d.child(cursorCover(cursor)));
  const key = keyOf();
  const open = showing();
  return div().id("drawer-root").relative().size_full()
    // A window overlay drags on any press its mod doesn't stop.
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .child(div().id("drawer-panel").absolute().top(0).left(0).h_full().overflow_hidden()
      .w(open ? (shared("agents-sidebar.width") ?? 268) : RAIL)
      .transition("width", motion())
      .on_size_change((_size, cx) => { if (!grown.has(key)) cx.timer.after(0, (cx) => { grown.add(key); cx.notify(); }); })
      .bg(t.chrome)
      .child(body)
      // The edge as a line over the panel's own background: a border sits outside it, and the theme's
      // border color is translucent, so what's under the drawer would show through.
      .child(div().absolute().top(0).bottom(0).right(0).w(1).bg(t.border))
      .when(Boolean(split), (d) => d.child(splitHandle(t, split === "spaces" ? "bottom" : "top")))
      .when(Boolean(cursor), (d) => d.child(cursorCover(cursor))));
}

// The panel's settings dialog (the palette's "Context panel: choose tabs"): every tab on offer, on or off, in order.
// Drag a row's grip to reorder; the release saves. Opening it scans for tab mods and reloads changed ones.
import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { closeOverlay, props, settings, setShared } from "herdr";
import { HERDR_TABS, KEY, config, enabledMods, isBuiltin, loadTabMods, scanTabMods } from "./tabs.js";

const ROW = 36, STEP = 38; // a row, and row plus gap
const SLIDE = { duration: 160, easing: "ease-out" };
const slug = (id) => id.replace(/[^A-Za-z0-9]+/g, "-");

export function initSettings(cx) {
  cx.spawn(async (cx) => {
    await scanTabMods();
    await loadTabMods(cx, enabledMods());
    cx.notify();
  });
}

// v: the dialog's view, which holds the drag: { id, py0, y0, y } (y is the held row's top in the list).
const zoom = () => settings().zoom ?? 1;
const dragOrder = (v, list) => {
  const rest = list.filter((c) => c.id !== v.drag.id);
  rest.splice(Math.max(0, Math.min(rest.length, Math.round(v.drag.y / STEP))), 0, list.find((c) => c.id === v.drag.id));
  return rest;
};
function startDrag(v, c, e, cx) {
  cx.stop_propagation();
  const y0 = config().findIndex((x) => x.id === c.id) * STEP;
  v.drag = { id: c.id, py0: e.position.y, y0, y: y0 };
  cx.notify();
}
function moveDrag(v, e, cx) {
  if (!v.drag) return;
  if (e.pressed_button !== "left") return endDrag(v, cx);
  const max = (config().length - 1) * STEP;
  v.drag.y = Math.max(-STEP / 2, Math.min(max + STEP / 2, v.drag.y0 + (e.position.y - v.drag.py0) / zoom()));
  cx.notify();
}
function endDrag(v, cx) {
  if (!v.drag) return;
  const list = config(), order = dragOrder(v, list);
  v.drag = null;
  if (order.some((c, i) => c.id !== list[i].id)) setShared(KEY, order);
  cx.notify();
}

export function settingsView(v, t) {
  const list = config();
  const slot = new Map((v.drag ? dragOrder(v, list) : list).map((c, i) => [c.id, i]));
  const set = (id, on, cx) => {
    setShared(KEY, config().map((c) => (c.id === id ? { ...c, on } : c)));
    if (on && !isBuiltin(id)) loadTabMods(cx, [id]);
  };
  const toggle = (c) => div().id(`toggle-${slug(c.id)}`).w(30).h(18).p(2).flex().flex_none().rounded(9).cursor_pointer()
    .bg(c.on ? t.accent : t.border).when(c.on, (el) => el.justify_end())
    .on_click((_e, cx) => set(c.id, !c.on, cx))
    .child(div().size(14).rounded(7).bg("#ffffff"));
  const row = (c) => {
    const held = v.drag?.id === c.id;
    return h_flex().id(`row-${slug(c.id)}`).absolute().left(0).w_full().h(ROW).pl(2).pr(8).gap(8).rounded(7).items_center()
      .top(held ? v.drag.y : slot.get(c.id) * STEP)
      .when(!held, (el) => el.transition("top", SLIDE))
      .when(held, (el) => el.bg(t.raised).shadow_lg())
      .when(!v.drag, (el) => el.hover((s) => s.bg(t.hover)))
      .child(div().id(`grip-${slug(c.id)}`).w(16).h(28).flex().flex_none().items_center().justify_center().rounded(4)
        .text_color(t.dim).when(!v.drag, (el) => el.cursor_grab().hover((s) => s.text_color(t.foreground))).tooltip("Drag to reorder")
        .on_mouse_down("left", (e, cx) => startDrag(v, c, e, cx))
        .child(svg("mods/opens-in/grip-vertical.svg").size(14)))
      .child(h_flex().flex_1().min_w(0).gap(8).items_center()
        .child(div().flex_none().child(c.title))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(t.dim).child(c.id === "summary" ? "Built in" : HERDR_TABS.has(c.id) ? "From Herdr" : c.id)))
      .child(c.id === "summary" ? div() : toggle(c));
  };
  return v_flex().id("settings").size_full().bg(t.popover).text_color(t.foreground).text_size(13)
    .on_window_mouse_up("left", (_e, cx) => endDrag(v, cx))
    .on_mouse_move((e, cx) => moveDrag(v, e, cx))
    .when(Boolean(v.drag), (el) => el.cursor_grabbing())
    .child(v_flex().px(18).pt(16).pb(10).gap(3).flex_none()
      .child(div().text_size(15).child("Context panel"))
      .child(div().text_size(12).text_color(t.muted).child("Choose the panel's tabs and their order. Tabs come from installed mods.")))
    .child(div().id("tabs").relative().flex_1().min_h(0).mx(10).overflow_y_scrollbar()
      .child(div().relative().w_full().h(list.length * STEP)
        // The held row last, so it's drawn on top.
        .children([...list].sort((a, b) => (a.id === v.drag?.id) - (b.id === v.drag?.id)).map(row))))
    .child(h_flex().px(18).py(12).flex_none().justify_end().border_t_1().border_color(t.border)
      .child(div().id("done").h(28).px(12).flex().items_center().rounded(7).cursor_pointer().text_size(12.8)
        .bg(t.solid).text_color(t.solid_foreground).on_click(() => closeOverlay(props().overlay)).child("Done")));
}

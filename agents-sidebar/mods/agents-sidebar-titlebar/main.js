// agents-sidebar-titlebar: the agents-sidebar layout's title bar: room for the macOS traffic lights, then the
// sidebar toggle (agents-sidebar-agents.collapse). The drawer's copy (props.peek) is its spacer: transparent,
// with the toggle where the bar has it ("keep open").
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { props, run, shared, theme, window } from "herdr";

// props.cursor: this copy is agents-sidebar-agents' full-window cursor layer during a sidebar drag (see drawer.js).
const cursorLayer = (kind) => {
  const d = div().id("drag-cursor").size_full();
  return kind === "row" ? d.cursor_row_resize() : d.cursor_col_resize();
};

export default class SideTitlebar extends View {
  render() {
    if (props()?.cursor) return cursorLayer(props().cursor);
    const t = theme();
    const peek = Boolean(props()?.peek);
    const mac = window()?.platform === "macos" && !window()?.fullscreen;
    return h_flex().id("titlebar").size_full().pl(mac ? 80 : 10).items_center()
      .when(!peek, (el) => el.bg(t.chrome).border_b(1).border_color(t.border))
      // A window overlay drags on any press its mod doesn't stop.
      .when(peek, (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation()))
      .child(div().id("sidebar-toggle").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(peek ? "Keep sidebar open" : "Toggle sidebar")
        // Not a window drag.
        .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
        .on_click(() => run("agents-sidebar-agents.collapse"))
        .child(svg("mods/workspace-chrome/sidebar.svg").size(15)))
      // The selected agent's name (agents-sidebar-agents publishes it); the drawer's spacer copy leaves it out.
      .when(!peek && Boolean(shared("agents-sidebar.active-title")), (el) =>
        el.child(div().ml(8).flex_1().min_w(0).truncate().text_size(13).text_color(t.foreground).child(shared("agents-sidebar.active-title"))));
  }
}

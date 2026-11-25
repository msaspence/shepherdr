// The setup dialog (the board opens this mod with props { variant: "setup", space, spaceName }):
// pick a provider, connect it (OAuth in the browser), pick what to show, and save it as the space's project.
// Also the spaces.json helpers the board reads with.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { appHome, closeOverlay, exec, props, readTextFile, setShared, theme, writeTextFile } from "herdr";
import { providers } from "./providers/index.js";

// Each space's project, by space id: { "<space id>": { "provider": "notion", ...that provider's settings } }.
export const CONFIG = "data/project-board/spaces.json"; // under the app home
export const REV_KEY = "project-board.config-rev"; // bumped on save, so open boards reload at once

export async function readConfig() {
  const text = await readTextFile(`${appHome()}/${CONFIG}`).catch(() => null);
  return { text, all: JSON.parse(text || "{}") };
}

async function saveSpace(space, entry) {
  await exec("mkdir", ["-p", `${appHome()}/data/project-board`]);
  const { text, all } = await readConfig();
  await writeTextFile(`${appHome()}/${CONFIG}`, JSON.stringify({ ...all, [space]: entry }, null, 2) + "\n", text);
  setShared(REV_KEY, Date.now());
}

export class Setup {
  init() {
    this.step = "provider"; // provider -> connecting -> projects; error from any of them
    this.error = null;
    this.provider = null; // [name, provider]
    this.draft = null; // the config connect resolved to
    this.items = [];
  }

  // Runs a step, showing what it throws.
  attempt(cx, work) {
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        await work();
      } catch (e) {
        Object.assign(this, { step: "error", error: String(e.message ?? e) });
      }
      cx.notify();
    });
  }

  connect(entry, cx) {
    Object.assign(this, { step: "connecting", provider: entry, error: null });
    this.attempt(cx, async () => {
      this.draft = await entry[1].connect({ space: props().space });
      this.items = await entry[1].projects(this.draft);
      this.step = "projects";
      if (this.items.length === 1) await this.save(this.items[0]); // nothing to choose
    });
  }

  async save(item) {
    await saveSpace(props().space, { provider: this.provider[0], ...this.draft, ...item.config });
    closeOverlay(props().overlay);
  }

  render() {
    const t = theme();
    const name = this.provider?.[1].name;
    const button = (id, label, onClick) => div().id(id).h(28).px(12).flex().items_center().rounded(7).cursor_pointer()
      .text_size(12.8).border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover))
      .on_click(onClick).child(label);
    // Even padding and tight lines, so the space between title and sub matches the space around them.
    const row = (id, icon, title, sub, onClick) => h_flex().id(id).min_h(36).px(10).py(9).gap(10).rounded(7).items_center()
      .cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick)
      .when(Boolean(icon), (el) => el.child(svg(icon).size(18).flex_none().text_color(t.foreground)))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(div().truncate().line_height("16px").child(title))
        .when(Boolean(sub), (el) => el.child(div().truncate().line_height("15px").text_size(12).text_color(t.muted).child(sub))));
    const note = (text, color = t.muted) => div().px(10).py(6).text_size(12.5).text_color(color).child(text);

    let body;
    if (this.step === "provider")
      body = v_flex().gap(2).child(note("Where are its tasks?"))
        .children(Object.entries(providers).map((entry) => row(`provider-${entry[0]}`, entry[1].icon, entry[1].name, entry[1].description,
          (_e, cx) => this.connect(entry, cx))));
    else if (this.step === "connecting")
      body = h_flex().px(10).py(12).gap(10).items_center()
        .child(svg("mods/workspace-chrome/spinner.svg").size(16).flex_none().text_color(t.muted).spin(900))
        .child(div().text_color(t.muted).child(`Finish connecting ${name} in your browser…`));
    else if (this.step === "projects")
      body = this.items.length
        ? v_flex().gap(2).child(note(`Which ${name} database should the board show?`))
          .children(this.items.map((item, i) => row(`project-${i}`, null, item.name, null, (_e, cx) => this.attempt(cx, () => this.save(item)))))
        : v_flex().gap(8).child(note(`Nothing was shared with the board. Connect again and pick your tasks database when ${name} asks.`))
          .child(h_flex().px(10).child(button("reconnect", "Connect again", (_e, cx) => this.connect(this.provider, cx))));
    else
      body = v_flex().gap(8).child(note(this.error, t.blocked))
        .child(h_flex().px(10).child(button("retry", "Try again", (_e, cx) => { this.step = "provider"; cx.notify(); })));

    return v_flex().id("setup").size_full().bg(t.popover).text_color(t.foreground).text_size(13)
      .child(v_flex().px(18).pt(16).pb(10).gap(3).flex_none()
        .child(div().text_size(15).child("Set up a project board"))
        .child(div().text_size(12).text_color(t.muted).child(`For the ${props().spaceName ?? "current"} space`)))
      .child(v_flex().id("setup-body").flex_1().min_h(0).px(8).overflow_y_scrollbar().child(body))
      .child(h_flex().px(18).py(12).flex_none().justify_end().border_t_1().border_color(t.border)
        .child(button("cancel", "Cancel", () => closeOverlay(props().overlay))));
  }
}

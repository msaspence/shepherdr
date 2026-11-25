// The setup dialog (the board opens this mod with props { variant: "setup", space, spaceName }):
// pick a provider, connect it (OAuth in the browser), pick what to show, and save it as the space's project.
// With variant "settings", the board's settings for a set-up space: tabs Databases (change what it shows)
// and Disconnect (forget the connection and the space's settings).
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

// entry null removes the space's project.
async function saveSpace(space, entry) {
  await exec("mkdir", ["-p", `${appHome()}/data/project-board`]);
  const { text, all } = await readConfig();
  if (entry) all[space] = entry;
  else delete all[space];
  await writeTextFile(`${appHome()}/${CONFIG}`, JSON.stringify(all, null, 2) + "\n", text);
  setShared(REV_KEY, Date.now());
}

export class Setup {
  init(cx) {
    this.step = "provider"; // provider -> connecting -> projects; error from any of them
    this.error = null;
    this.provider = null; // [name, provider]
    this.draft = null; // the config connect resolved to (settings: the space's config)
    this.items = [];
    this.picked = new Set(); // item ids
    this.settings = props().variant === "settings";
    this.tab = "databases"; // settings: databases | disconnect
    if (!this.settings) return;
    this.step = "loading";
    this.attempt(cx, async () => {
      const { provider: name, ...config } = (await readConfig()).all[props().space] ?? {};
      if (!providers[name]) throw new Error("This space has no project board");
      Object.assign(this, { provider: [name, providers[name]], draft: config });
      this.items = await providers[name].projects(config);
      this.picked = new Set(config.projects ?? []);
      this.step = "projects";
    });
  }

  async disconnect() {
    await this.provider[1].disconnect?.(this.draft);
    await saveSpace(props().space, null);
    closeOverlay(props().overlay);
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
      this.picked = new Set();
      this.step = "projects";
      const usable = this.items.filter((x) => !x.unusable);
      if (usable.length === 1 && this.items.length === 1) await this.save([usable[0].id]); // nothing to choose
    });
  }

  async save(ids) {
    await saveSpace(props().space, { provider: this.provider[0], ...this.draft, projects: ids });
    closeOverlay(props().overlay);
  }

  render() {
    const t = theme();
    const name = this.provider?.[1].name;
    const button = (id, label, onClick, primary = false) => div().id(id).h(28).px(12).flex().items_center().rounded(7)
      .text_size(12.8)
      .when(primary && Boolean(onClick), (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(primary && !onClick, (el) => el.bg(t.border).text_color(t.dim)) // disabled
      .when(!primary, (el) => el.border_1().border_color(t.border).text_color(t.foreground).hover((s) => s.bg(t.hover)))
      .when(Boolean(onClick), (el) => el.cursor_pointer().on_click(onClick))
      .child(label);
    const checkbox = (on) => div().size(16).flex().flex_none().items_center().justify_center().rounded(4)
      .when(on, (el) => el.bg(t.accent).text_color("#ffffff"))
      .when(!on, (el) => el.border_1().border_color(t.muted))
      .when(on, (el) => el.child(svg("mods/workspace-chrome/check.svg").size(12)));
    // Even padding and tight lines, so the space between title and sub matches the space around them.
    // icon: an svg path, or an element (a checkbox).
    const row = (id, icon, title, sub, onClick) => h_flex().id(id).min_h(36).px(10).py(9).gap(10).rounded(7).items_center()
      .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick))
      .when(Boolean(icon), (el) => el.child(typeof icon === "string" ? svg(icon).size(18).flex_none().text_color(t.foreground) : icon))
      .child(v_flex().flex_1().min_w(0).gap(4)
        .child(div().truncate().line_height("16px").child(title))
        .when(Boolean(sub), (el) => el.child(div().line_height("15px").text_size(12).text_color(t.muted).child(sub))));
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
        ? v_flex().gap(2).child(note(`Which ${name} databases should the board show?`))
          // A saved database that's no longer shared: listed so it can be unticked.
          .children([...this.picked].filter((id) => !this.items.some((x) => x.id === id)).map((id) =>
            row(`gone-${id}`, checkbox(true), "A database no longer shared", id, (_e, cx) => { this.picked.delete(id); cx.notify(); })))
          .children(this.items.map((item, i) => item.unusable
            ? row(`project-${i}`, checkbox(false), item.name, item.unusable, null).opacity(0.5)
            : row(`project-${i}`, checkbox(this.picked.has(item.id)), item.name, null, (_e, cx) => {
              if (!this.picked.delete(item.id)) this.picked.add(item.id);
              cx.notify();
            })))
        : v_flex().gap(8).child(note(`Nothing was shared with the board. Connect again and pick your tasks database when ${name} asks.`))
          .child(h_flex().px(10).child(button("reconnect", "Connect again", (_e, cx) => this.connect(this.provider, cx))));
    else if (this.step === "loading")
      body = h_flex().px(10).py(12).gap(10).items_center()
        .child(svg("mods/workspace-chrome/spinner.svg").size(16).flex_none().text_color(t.muted).spin(900))
        .child(div().text_color(t.muted).child("Loading…"));
    else
      body = v_flex().gap(8).child(note(this.error, t.blocked))
        .when(!this.settings, (el) => el.child(h_flex().px(10).child(button("retry", "Try again", (_e, cx) => { this.step = "provider"; cx.notify(); }))));

    if (this.settings && this.tab === "disconnect")
      body = v_flex().gap(10).child(note(`Disconnects ${name ?? "the integration"} and forgets this space's board settings. `
        + "The board goes back to its set up screen, and setting it up again signs in again."))
        .child(h_flex().px(10).child(div().id("disconnect").h(28).px(12).flex().items_center().rounded(7).cursor_pointer()
          .text_size(12.8).bg(t.ansi1).text_color("#ffffff").hover((s) => s.opacity(0.9))
          .on_click((_e, cx) => this.attempt(cx, () => this.disconnect())).child(`Disconnect ${name ?? ""}`.trim())));

    const tabs = [["databases", "Databases"], ["disconnect", "Disconnect"]];
    const tabBar = h_flex().px(14).pb(8).gap(2).flex_none().children(tabs.map(([id, title]) =>
      h_flex().id(`tab-${id}`).h(26).px(10).rounded(6).items_center().cursor_pointer()
        .text_color(id === this.tab ? t.foreground : t.muted)
        .when(id === this.tab, (el) => el.bg(t.selected))
        .when(id !== this.tab, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
        .on_click((_e, cx) => { this.tab = id; cx.notify(); }).child(title)));
    const picking = this.step === "projects" && this.items.length + this.picked.size > 0 && this.tab === "databases";
    const ids = () => [...this.picked];

    return v_flex().id("setup").size_full().bg(t.popover).text_color(t.foreground).text_size(13)
      .child(v_flex().px(18).pt(16).pb(10).gap(3).flex_none()
        .child(div().text_size(15).child(this.settings ? "Project board settings" : "Set up a project board"))
        .child(div().text_size(12).text_color(t.muted).child(`For the ${props().spaceName ?? "current"} space`)))
      .when(this.settings, (el) => el.child(tabBar))
      .child(v_flex().id("setup-body").flex_1().min_h(0).px(8).overflow_y_scrollbar().child(body))
      .child(h_flex().px(18).py(12).gap(8).flex_none().justify_end().border_t_1().border_color(t.border)
        .child(button("cancel", "Cancel", () => closeOverlay(props().overlay)))
        .when(picking, (el) => el.child(button("save", this.settings ? "Save" : "Show on board",
          this.picked.size ? (_e, cx) => this.attempt(cx, () => this.save(ids())) : null, true))));
  }
}

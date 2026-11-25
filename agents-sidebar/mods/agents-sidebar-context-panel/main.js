// agents-sidebar-context-panel: a right-hand panel beside an agent, as a mod pane in the agent's own tab, so each agent
// has its own. Tabs across the top (a dropdown when the pane is too narrow for them); Summary shows the agent's
// folder (with an Open In button) and its git branch with the changes from the base branch, then lines other
// mods add. Other tabs come from mods too (tabs.js), chosen and ordered in the settings dialog (settings.js).
// Copies: the pane (props.tab, the tab it was opened in), the title bar button (props.variant "toggle"), and the
// settings dialog (no props: the palette's mod.open).
import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, Popover } from "gpui-base";
import { checking, exec, focused, home, openOverlay, panes, props, run, shared, theme } from "herdr";
import { HERDR_TABS, MOD, config, enabledMods, herdrView, loadTabMods, registry, scanTabMods } from "./tabs.js";
import { initSettings, settingsView } from "./settings.js";

const WIDTH = 340; // the pane's width when it opens
const POLL = 5000;

// The enabled tabs in the person's order: Summary (always), Herdr's Files and Changes, and mods that have registered.
const tabs = () => {
  const reg = registry();
  return config().filter((c) => c.id === "summary" || (c.on && (HERDR_TABS.has(c.id) || reg[c.id]?.render)))
    .map((c) => ({ id: c.id, title: c.title, render: reg[c.id]?.render }));
};

// The panel pane in a tab, and the agent pane beside it (the tab's first terminal).
const panelIn = (tab) => panes().find((p) => p.tab === tab && p.mod === MOD);
const agentIn = (tab) => panes().find((p) => p.tab === tab && p.terminal);

export function togglePanel() {
  const tab = focused()?.tab;
  if (!tab) return;
  const open = panelIn(tab);
  if (open) return run("pane.close", { pane: open.pane });
  const agent = agentIn(tab);
  run("pane.split", { direction: "right", ...(agent ? { pane: agent.pane } : {}), mod: MOD, props: { tab } });
}

// The base branch (origin's default, else main or master), then the change from where HEAD left it,
// working tree included: "<added> <removed>". Untracked files aren't counted.
const GIT_STAT = `
base=$(git symbolic-ref -q --short refs/remotes/origin/HEAD) || base=
for b in main master; do [ -n "$base" ] && break; git rev-parse -q --verify "$b" >/dev/null && base=$b; done
[ -n "$base" ] || exit 1
mb=$(git merge-base HEAD "$base") || exit 1
git diff --shortstat "$mb" | awk '{a=0;d=0;for(i=1;i<=NF;i++){if($(i+1)~/^insertion/)a=$i;if($(i+1)~/^deletion/)d=$i}} END{print a+0, d+0}'
`;

const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

export default class Panel extends View {
  init(_props, cx) {
    this.variant = props()?.variant ?? (props()?.tab ? "panel" : "settings");
    if (this.variant === "settings") return checking() || initSettings(cx);
    if (this.variant !== "panel") return;
    this.active = "summary";
    this.width = 0;
    this.stat = null; // { cwd, add, del }
    this.views = {}; // Herdr's panels, nested (cx.new) the first time their tab is shown: id -> Entity | { error }
    if (checking()) return;
    cx.spawn(async (cx) => { await scanTabMods(); await loadTabMods(cx, enabledMods()); });
    this.refresh(cx);
    cx.timer.every(POLL, (cx) => this.refresh(cx));
  }

  agent() {
    return agentIn(props()?.tab);
  }

  refresh(cx) {
    loadTabMods(cx, enabledMods()); // picks up a tab mod that was edited since
    const cwd = this.agent()?.cwd;
    if (!cwd || this.busy) return;
    this.busy = true;
    cx.spawn(async (cx) => {
      try {
        const r = await exec("sh", ["-c", GIT_STAT], { cwd });
        const [add, del] = r.code === 0 ? r.stdout.trim().split(" ").map(Number) : [];
        this.stat = r.code === 0 ? { cwd, add, del } : null;
      } catch {
        this.stat = null;
      }
      this.busy = false;
      cx.notify();
    });
  }

  // A new split is half the tab: bring it to WIDTH once, the first time it's measured.
  sized(size, cx) {
    const first = !this.width;
    if (size.width !== this.width) { this.width = size.width; cx.notify(); }
    if (!first || size.width <= WIDTH + 24) return;
    const me = panelIn(props()?.tab);
    if (me) run("pane.resize", { pane: me.pane, direction: "right", px: Math.round(size.width - WIDTH) });
  }

  render(cx) {
    const t = theme();
    if (this.variant === "toggle") return this.toggle(t);
    if (this.variant === "settings") return settingsView(this, t);
    this.active = this.shown();
    // The sidebar's look: its chrome background, and a 1px border line on the edge facing the agent.
    return h_flex().id("panel").size_full().bg(t.chrome).text_size(13).text_color(t.foreground)
      .on_size_change((size, cx) => this.sized(size, cx))
      .child(div().w(1).h_full().flex_none().bg(t.border))
      .child(v_flex().flex_1().min_w(0).h_full()
      .child(this.tabs(t))
      .child(HERDR_TABS.has(this.active)
        ? v_flex().id("panel-body").flex_1().min_h(0).p(4).child(this.herdrTab(t, this.active, cx))
        : v_flex().id("panel-body").flex_1().min_h(0).p(10).gap(2).overflow_y_scrollbar().child(this.content(t, cx))));
  }

  // The active tab, or Summary once it's been turned off or its mod is gone.
  shown() {
    return tabs().some((x) => x.id === this.active) ? this.active : "summary";
  }

  // Herdr's own Files or Changes panel, the same view its layouts show (it follows the focused pane's folder).
  herdrTab(t, id, cx) {
    const v = this.views[id];
    if (!v && !checking()) {
      this.views[id] = { loading: true };
      cx.spawn(async (cx) => {
        try {
          this.views[id] = cx.new(await herdrView(id), {});
        } catch (e) {
          this.views[id] = { error: String(e?.message ?? e) };
        }
        cx.notify();
      });
    }
    if (v?.error) return div().p(14).text_size(12).text_color(t.blocked).child(v.error);
    return v && !v.loading ? v : div();
  }

  content(t, cx) {
    if (this.active === "summary") return this.summary(t, cx);
    const tab = tabs().find((x) => x.id === this.active);
    return tab ? this.guard(tab.id, () => tab.render(this.ctx(t, tab.id, cx))) : this.summary(t, cx);
  }

  // A registered mod's failure shows in its own place, not as the whole panel failing.
  guard(id, fn) {
    try {
      return fn() ?? div();
    } catch (e) {
      return div().px(4).py(6).text_size(12).text_color(theme().blocked).child(`${id}: ${e?.message ?? e}`);
    }
  }

  line(t, id, icon, text, right) {
    return h_flex().id(id).h(30).px(4).gap(8).items_center().flex_none()
      .child(svg(icon).size(14).flex_none().text_color(t.muted))
      .child(div().flex_1().min_w(0).truncate().child(text))
      .when(Boolean(right), (el) => el.child(right));
  }

  // What a registered mod's render/summary/header gets. state is this panel's own object for that mod (kept
  // while the panel lives), width the pane's, show(id) switches the panel to a tab (call cx.notify after).
  ctx(t, id, cx) {
    const agent = this.agent();
    this.modState ??= {};
    return { t, cx, agent, cwd: agent?.cwd ?? null, branch: agent?.branch ?? null, width: this.width,
      state: (this.modState[id] ??= {}), show: (tab) => { this.active = tab; },
      line: (lid, icon, text, right) => this.line(t, lid, icon, text, right) };
  }

  tabs(t) {
    const TABS = tabs();
    const current = TABS.find((x) => x.id === this.active) ?? TABS[0];
    const select = (id) => (_e, cx) => { this.active = id; this.menuOpen = false; cx.notify(); };
    const bar = h_flex().h(36).px(8).gap(2).flex_none().items_center();
    // The strip's own width is measured while it's shown (it's shown until then); narrower than that, a dropdown.
    if (this.width && this.tabsW && this.width < this.tabsW + 17) {
      const item = (x) => h_flex().id(`pick-${x.id}`).h(28).px(8).rounded(6).items_center().cursor_pointer()
        .when(x.id === this.active, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click(select(x.id)).child(x.title);
      return bar.child(Popover.new("panel-tab-picker").anchor("top_left").open(Boolean(this.menuOpen))
        .on_open_change((open, cx) => { this.menuOpen = open; cx.notify(); })
        .trigger(h_flex().id("panel-tab-trigger").h(26).px(8).gap(6).rounded(6).items_center().cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .child(current.title).child(svg("mods/workspace-chrome/chevron-down.svg").size(12).text_color(t.muted)))
        .content(v_flex().w(160).p(4).gap(2).rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_lg()
          .children(TABS.map(item))));
    }
    return bar.child(h_flex().flex_none().gap(2)
      .on_size_change((size, cx) => { if (size.width !== this.tabsW) { this.tabsW = size.width; cx.notify(); } })
      .children(TABS.map((x) => h_flex().id(`tab-${x.id}`).h(26).px(10).rounded(6).items_center().cursor_pointer()
      .text_color(x.id === this.active ? t.foreground : t.muted)
      .when(x.id === this.active, (el) => el.bg(t.selected))
      .when(x.id !== this.active, (el) => el.hover((s) => s.bg(t.hover).text_color(t.foreground)))
      .on_click(select(x.id)).child(x.title))));
  }

  summary(t, cx) {
    const agent = this.agent();
    const cwd = agent?.cwd;
    const stat = this.stat?.cwd === cwd ? this.stat : null;
    const line = (id, icon, text, right) => this.line(t, id, `mods/workspace-chrome/${icon}.svg`, text, right);
    const extra = enabledMods().map((id) => [id, registry()[id]]).filter(([, r]) => r?.summary);
    return v_flex()
      .child(line("summary-folder", "folder", cwd ? cwd.replace(home(), "~") : "No folder", cwd ? this.openIn(t, cwd) : null))
      .child(line("summary-branch", "git-branch", agent?.branch ?? "Not a git repository",
        stat ? h_flex().gap(6).flex_none().text_size(12)
          .child(div().text_color(stat.add ? t.ansi2 : t.dim).child(`+${stat.add}`))
          .child(div().text_color(stat.del ? t.ansi1 : t.dim).child(`-${stat.del}`)) : null))
      .children(extra.map(([id, r]) => this.guard(id, () => {
        const ctx = this.ctx(t, id, cx);
        const lines = r.summary(ctx);
        const header = typeof r.header === "function" ? r.header(ctx) : r.header;
        return lines && header ? v_flex().child(this.header(t, id, header)).child(lines) : lines;
      })));
  }

  // A registered mod's optional label over its Summary lines.
  header(t, id, text) {
    return div().id(`summary-header-${id}`).px(4).pt(12).pb(2).text_size(11.5).font_semibold().text_color(t.dim).child(text);
  }

  // opens-in's button-icon: its own dropdown ("menu" variant) for this folder.
  openIn(t, path) {
    const n = Math.max(1, ((shared("opens-in.apps") ?? []).filter((a) => a.on)).length);
    return div().id("summary-open-in").size(24).flex().flex_none().items_center().justify_center().rounded(6).cursor_pointer()
      .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Open In")
      .on_mouse_down("left", (e) => { if (e.bounds) this.bounds = e.bounds; })
      .on_click(() => {
        const b = this.bounds;
        openOverlay({ mod: "opens-in", kind: "popup", props: { variant: "menu", path },
          ...(b ? { at: { x: b.x + b.width - 220, y: b.y + b.height + 4 } } : { at: "pointer" }),
          width: 220, height: Math.min(400, 12 + n * 32) });
      })
      .child(svg("mods/opens-in/external-link.svg").size(14));
  }

  toggle(t) {
    const tab = focused()?.tab;
    const open = Boolean(tab && panelIn(tab));
    return h_flex().size_full().pr(10).items_center().justify_end()
      .child(stop(div().id("panel-toggle").size(26).flex_none().flex().items_center().justify_center().rounded(6)
        .text_color(open ? t.foreground : t.muted).when(open, (el) => el.bg(t.selected))
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .tooltip(open ? "Hide panel" : "Show panel")
        .on_click(togglePanel)
        .child(svg("mods/workspace-chrome/panel-right.svg").size(15))));
  }
}

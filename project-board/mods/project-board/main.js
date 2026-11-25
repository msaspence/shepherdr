import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { PathBuilder, Background } from "gpui-kit";
import { providers } from "./providers/index.js";
import { CONFIG, REV_KEY, Setup, readConfig } from "./setup.js";
import { agents, spaces, panes, terminals, theme, run, exec, home, appHome, readTextFile, shared, setShared, checking, openOverlay, props } from "herdr";

// Each space's project is in setup.js's CONFIG; a space without an entry gets a call to set one up.
const LINK_LOG = "/tmp/herdr-agent-links.jsonl";
const LINK_TTL_MS = 10 * 60 * 1000;
const CARD_W = 260;
const CARD_H = 130; // until a card reports its measured height
const POS_KEY = "project-board.pos";
const SESSIONS_KEY = "project-board.sessions"; // task key -> { chat, sessionFile, provider, cwd, tab }: its last chat session
const GRID_FROZEN_KEY = "project-board.grid-frozen";
const NEW_CARD_H = 150; // a new card's height before it has been measured
const GAP = 24;
const VIEW_KEY = "project-board.view"; // { x, y, z }: pan offset in screen px, zoom
const MIN_ZOOM = 0.3;
const MAX_ZOOM = 2.5;
const TASK_ID = /\b([A-Z]{2}-\d+)\b/i;
const GREEN = "#3fb950";
// Status pill colors, [dot, fill], by the status's stage.
const STAGE_COLORS = { queued: ["#D0A548", "#836A35"], progress: ["#4481D8", "#45699B"], done: ["#5F9F75", "#486A52"] };
const CACHE = "mods/project-board/.cache"; // hidden, so downloads don't hot-reload the mod

// Where an icon url is cached: the url's last part (names could collide across hosts; hash the url if a provider ever mixes them).
const iconFile = (url) => `icons/${url.split("/").pop()}`;

// One PR's checks: "failed" if any failed, else "pending" if any are still running, else "passed"; null if it has none.
function prChecks(rollup) {
  const FAILED = ["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"];
  const states = rollup.map((c) =>
    c.__typename === "StatusContext"
      ? c.state === "PENDING" || c.state === "EXPECTED" ? "pending" : FAILED.includes(c.state) ? "failed" : "passed"
      : c.status !== "COMPLETED" ? "pending" : FAILED.includes(c.conclusion) ? "failed" : "passed"
  );
  return states.includes("failed") ? "failed" : states.includes("pending") ? "pending" : states.length ? "passed" : null;
}

// `amount` of color `a` over color `b`, as one opaque #rrggbb. Theme colors are hex; anything else falls back to `b`.
function mix(a, b, amount) {
  const rgb = (c) => (/^#[0-9a-f]{6}/i.test(c) ? [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16)) : null);
  const [x, y] = [rgb(a), rgb(b)];
  if (!x || !y) return b;
  return "#" + x.map((v, i) => Math.round(v * amount + y[i] * (1 - amount)).toString(16).padStart(2, "0")).join("");
}

/** Whiteboard of project tasks (from providers/): draggable cards, orthogonal "Blocked by" arrows,
 *  glowing avatars for agents working each task, and green curves for recent agent-to-agent messages. */
export default class ProjectBoard extends View {
  init(_props, cx) {
    if (props()?.variant === "setup") return (this.setup = new Setup()).init(cx);
    // Carry over card positions, view and sessions saved while this mod was called notion-board.
    for (const key of [POS_KEY, SESSIONS_KEY, GRID_FROZEN_KEY, VIEW_KEY]) {
      const old = key.replace("project-board.", "notion-board.");
      if (shared(key) == null && shared(old) != null) setShared(key, shared(old));
    }
    this.tasks = [];
    this.links = [];
    this.error = null;
    this.drag = null; // { key, x, y, dx, dy, group: { key: offset from the dragged card } }, board units
    this.selected = new Set();
    this.checks = {}; // task key -> "failed" | "pending" | "passed": its open PRs' checks
    this.marquee = null; // { x0, y0, x1, y1, add }, screen px within the board
    this.heights = {}; // measured, in board units
    this.view = shared(VIEW_KEY) ?? { x: 0, y: 0, z: 1 };
    this.cached = new Set();
    if (checking()) {
      // Exercise cards, arrows and curves under `herdr-app check`.
      this.tasks = [
        { id: "a", key: "OI-1", title: "Blocker", icon: { emoji: "🔨" }, status: { name: "Coding", stage: "progress" }, people: [{ id: "u", name: "Matthew" }], blockedBy: [], url: "" },
        { id: "b", key: "OI-2", title: "Blocked", icon: null, status: null, people: [], blockedBy: ["a"], url: "" },
      ];
      this.links = [{ pair: "OI-1|OI-2", at: Date.now() }];
      this.hovered = "OI-1";
      for (const p of Object.values(providers)) p.check?.();
      this.provider = providers.notion;
      const ok = (c) => ({ __typename: "CheckRun", status: "COMPLETED", conclusion: c });
      if (prChecks([ok("SUCCESS"), ok("FAILURE")]) !== "failed" || prChecks([ok("SUCCESS"), { __typename: "CheckRun", status: "IN_PROGRESS" }]) !== "pending" || prChecks([ok("SUCCESS"), ok("SKIPPED")]) !== "passed" || prChecks([]) !== null) throw new Error("prChecks is wrong");
      if (mix("#ff0000", "#000000", 0.25) !== "#400000" || mix("nope", "#123456", 0.5) !== "#123456") throw new Error("mix is wrong");
      this.placeNewCards();
      const [a, b] = this.tasks.map((t) => shared(POS_KEY)[t.key]);
      if (!a || !b || (Math.abs(a.x - b.x) < CARD_W && Math.abs(a.y - b.y) < NEW_CARD_H)) throw new Error("new cards overlap");
      return;
    }
    this.load(cx);
    this.readLinks(cx);
    cx.timer.every(60_000, (cx) => this.load(cx));
    // The board shows the shown space's project: it's the board's own space whenever the board is on screen.
    // ...and reloads when a setup dialog saves.
    cx.timer.every(1_000, (cx) => (spaces().find((s) => s.active)?.id !== this.space || shared(REV_KEY) !== this.rev) && this.load(cx));
    cx.timer.every(5_000, (cx) => this.readLinks(cx));
    cx.timer.every(10_000, (cx) => this.rememberSessions(cx));
    this.loadChecks(cx);
    cx.timer.every(30_000, (cx) => this.loadChecks(cx));
  }

  load(cx) {
    if (this.loading) return;
    this.loading = true;
    this.rev = shared(REV_KEY);
    cx.notify();
    const space = spaces().find((s) => s.active);
    if (space?.id !== this.space) Object.assign(this, { space: space?.id, spaceName: space?.name, tasks: [], error: null, provider: null, unconfigured: false });
    cx.spawn(async (cx) => {
      try {
        const { all } = await readConfig();
        const config = all[space?.id];
        const provider = config ? providers[config.provider] : null;
        // Set before loading, so a failed load shows its error rather than the setup call.
        if (space?.id === this.space) Object.assign(this, { unconfigured: !config, provider });
        if (config && !provider) throw new Error(`no provider called "${config.provider}" (have: ${Object.keys(providers).join(", ")})`);
        const tasks = provider ? await provider.load({ config, onBoard: new Set(Object.keys(shared(POS_KEY) ?? {})) }) : [];
        if (space?.id !== this.space) return; // switched space while loading
        this.tasks = tasks;
        this.error = null;
        this.freezeOldGrid();
        this.tasks.sort((a, b) => a.rank[0] - b.rank[0] || a.rank[1] - b.rank[1]);
        this.placeNewCards();
        cx.notify();
        for (const task of this.tasks) {
          if (task.icon?.svg) await this.cache(task.icon.svg, iconFile(task.icon.svg));
          for (const u of task.people) if (u.avatar) await this.cache(u.avatar, `avatars/${u.id}${u.avatar.match(/\.\w+$/)?.[0] ?? ""}`);
        }
      } catch (e) {
        if (space?.id === this.space) this.error = String(e.message ?? e);
      } finally {
        this.loading = false;
        cx.notify();
      }
    });
  }

  // Downloads once into the mod's cache; `cachedPath` stays null until the file exists (or the download failed).
  async cache(url, name) {
    if (this.cached.has(name)) return;
    const r = await exec("sh", ["-c", 'test -s "$1" || curl -sfL --create-dirs -o "$1" "$2"', "_", `${appHome()}/${CACHE}/${name}`, url]).catch(() => null);
    if (r?.code === 0) this.cached.add(name);
  }

  cachedPath(name) {
    return this.cached.has(name) ? `${CACHE}/${name}` : null;
  }

  height(key) {
    return this.heights[key] ?? CARD_H;
  }

  // Remembers the session of each task's live chat agent (herdr-chat's record of the chat its host terminal runs),
  // so the card can resume it once the chat is closed. ponytail: chats only; a Claude TUI's session isn't recorded.
  rememberSessions(cx) {
    cx.spawn(async () => {
      const labels = Object.fromEntries(terminals().map((term) => [term.address, term.labels ?? {}]));
      const saved = { ...(shared(SESSIONS_KEY) ?? {}) };
      let changed = false;
      for (const [key, list] of Object.entries(this.agentsByTask())) {
        for (const a of list) {
          const chat = labels[a.address]?.["herdr-chat.chat"];
          if (!chat || saved[key]?.chat === chat) continue;
          const entry = JSON.parse((await readTextFile(`${appHome()}/data/herdr-chat/chats/${chat}.json`).catch(() => null)) || "{}");
          if (!entry.sessionFile) continue; // still starting: try again next time
          saved[key] = { chat, sessionFile: entry.sessionFile, provider: entry.provider || "claude", cwd: entry.cwd, tab: a.tab_name };
          changed = true;
        }
      }
      if (changed) setShared(SESSIONS_KEY, saved);
    });
  }

  // Open PRs' checks (changes requested counting as failed), by the task ID in each PR's title or branch, worst first: failed, pending, passed.
  loadChecks(cx) {
    cx.spawn(async (cx) => {
      // The repo: where the task chats work, else any pane's folder, else the space's (often home, not a repo).
      const dirs = [
        ...Object.values(shared(SESSIONS_KEY) ?? {}).map((rec) => rec.cwd),
        ...panes().map((p) => p.cwd),
        spaces().find((s) => s.active)?.folder,
      ];
      let r = null;
      for (const cwd of new Set(dirs.filter(Boolean))) {
        r = await exec("gh", ["pr", "list", "--state", "open", "--limit", "100", "--json", "title,headRefName,statusCheckRollup,reviewDecision"], { cwd }).catch(() => null);
        if (r?.code === 0) break;
      }
      if (r?.code !== 0) return; // no gh, no repo, offline: keep the last known checks
      const rank = { failed: 3, pending: 2, passed: 1 };
      const checks = {};
      for (const pr of JSON.parse(r.stdout)) {
        const m = TASK_ID.exec(pr.headRefName) ?? TASK_ID.exec(pr.title);
        // Changes requested needs action as much as a failed check does.
        const state = pr.reviewDecision === "CHANGES_REQUESTED" ? "failed" : prChecks(pr.statusCheckRollup ?? []);
        if (!m || !state) continue;
        const key = m[1].toUpperCase();
        if ((rank[state] ?? 0) > (rank[checks[key]] ?? 0)) checks[key] = state;
      }
      if (JSON.stringify(checks) === JSON.stringify(this.checks)) return;
      this.checks = checks;
      cx.notify();
    });
  }

  // A new chat tab on the task's last session, as Herdr's reopen-tab does.
  resumeSession(task) {
    const rec = shared(SESSIONS_KEY)?.[task.key];
    if (!rec) return;
    const space = spaces().find((s) => s.active);
    run("tab.new", {
      name: rec.tab || task.key,
      space: space?.id,
      mod: "chat",
      props: { chat: `c-${Math.random().toString(16).slice(2, 10)}`, provider: rec.provider, ...(rec.cwd ? { cwd: rec.cwd } : {}), session: rec.sessionFile },
    });
  }

  readLinks(cx) {
    cx.spawn(async (cx) => {
      const r = await exec("tail", ["-n", "500", LINK_LOG]).catch(() => null);
      const latest = {};
      for (const line of (r?.stdout ?? "").split("\n")) {
        try {
          const { ts, from, to } = JSON.parse(line);
          const pair = [from.toUpperCase(), to.toUpperCase()].sort().join("|");
          latest[pair] = Math.max(latest[pair] ?? 0, ts * 1000);
        } catch {}
      }
      const now = Date.now();
      const links = Object.entries(latest)
        .filter(([, at]) => now - at < LINK_TTL_MS)
        .map(([pair, at]) => ({ pair, at }));
      if (JSON.stringify(links) !== JSON.stringify(this.links)) {
        this.links = links;
        cx.notify();
      }
    });
  }

  positions() {
    const saved = shared(POS_KEY) ?? {};
    const pos = {};
    this.tasks.forEach((t, i) => {
      pos[t.key] = saved[t.key] ?? { x: 40 + (i % 4) * (CARD_W + 50), y: 40 + Math.floor(i / 4) * (CARD_H + 70) };
    });
    if (this.drag) {
      pos[this.drag.key] = { x: this.drag.x, y: this.drag.y };
      for (const [k, off] of Object.entries(this.drag.group)) pos[k] = { x: this.drag.x + off.x, y: this.drag.y + off.y };
    }
    return pos;
  }

  // Once: cards never dragged sat in a grid by the provider's order; save that so they don't move.
  freezeOldGrid() {
    if (shared(GRID_FROZEN_KEY)) return;
    setShared(POS_KEY, this.positions());
    setShared(GRID_FROZEN_KEY, true);
  }

  // A card without a position goes no higher than the card ranked just above it (priority, then ID),
  // in the first free spot, scanning right then down, that overlaps no card already on the board.
  placeNewCards() {
    const saved = { ...(shared(POS_KEY) ?? {}) };
    const fresh = this.tasks.filter((t) => !saved[t.key]);
    if (!fresh.length) return;
    const shown = new Set(this.tasks.map((t) => t.key));
    const rects = Object.entries(saved)
      .filter(([k]) => shown.has(k))
      .map(([k, p]) => ({ ...p, h: this.heights[k] ?? NEW_CARD_H }));
    const hits = (x, y) => rects.some((r) => x < r.x + CARD_W + GAP && r.x < x + CARD_W + GAP && y < r.y + r.h + GAP && r.y < y + NEW_CARD_H + GAP);
    for (const task of fresh) {
      const above = this.tasks.slice(0, this.tasks.indexOf(task)).reverse().find((t) => saved[t.key]);
      const top = above ? saved[above.key].y : 40;
      const left = Math.min(40, ...rects.map((r) => r.x));
      // ponytail: brute-force scan, fine for a board of tens of cards
      search: for (let y = top; ; y += GAP) {
        for (let x = left; x < left + 6 * (CARD_W + GAP); x += CARD_W + GAP) {
          if (hits(x, y)) continue;
          saved[task.key] = { x, y };
          rects.push({ x, y, h: NEW_CARD_H });
          break search;
        }
      }
    }
    setShared(POS_KEY, saved);
  }

  agentsByTask() {
    const branch = Object.fromEntries(spaces().map((s) => [s.id, s.branch ?? ""]));
    const out = {};
    for (const a of agents()) {
      const m = [a.pane_name, a.tab_name, a.title, branch[a.space], a.space_name].map((s) => TASK_ID.exec(s ?? "")).find(Boolean);
      if (m) (out[m[1].toUpperCase()] ??= []).push(a);
    }
    // A chat still starting hasn't reported a status, so it isn't an agent yet: a task-named tab with a chat pane
    // and no agent stands in for it as "starting".
    const agentTabs = new Set(agents().map((a) => a.tab));
    const chatPanes = panes().filter((p) => p.mod === "chat");
    for (const tab of spaces().flatMap((sp) => sp.tabs)) {
      const m = TASK_ID.exec(tab.name);
      const pane = chatPanes.find((p) => p.tab === tab.id);
      if (!m || !pane || agentTabs.has(tab.id)) continue;
      (out[m[1].toUpperCase()] ??= []).push({ address: `starting-${tab.id}`, pane: pane.pane, status: "starting", program: { icon: "icons/claude.svg", tint: false, name: "Claude" } });
    }
    return out;
  }

  render(cx) {
    if (this.setup) return this.setup.render(cx);
    const t = theme();
    // Before any tasks have loaded an error is all there is to show; after, a failed refresh keeps the last cards.
    if (this.unconfigured) return this.blankSlate(t);
    if (this.error && !this.tasks.length)
      return this.message(t, `${this.provider?.name ?? "Project board"}: ${this.error}`, this.provider?.setupHint ?? `Check ~/.config/herdr-app/${CONFIG}`)
        .child(this.setupButton(t, "Set up again"));
    if (!this.tasks.length) return this.message(t, "No tasks yet", "Loading tasks…");

    const { x: ox, y: oy, z } = this.view;
    const world = this.positions();
    const pos = Object.fromEntries(Object.entries(world).map(([k, p]) => [k, { x: p.x * z + ox, y: p.y * z + oy }]));
    const h = (k) => this.height(k) * z;
    const byPage = Object.fromEntries(this.tasks.map((x) => [x.id, x]));
    const byAgent = this.agentsByTask();
    const center = (k) => ({ x: pos[k].x + (CARD_W * z) / 2, y: pos[k].y + h(k) / 2 });

    const layers = [];
    for (const task of this.tasks)
      for (const b of task.blockedBy) if (byPage[b]) layers.push(this.arrow(pos[byPage[b].key], h(byPage[b].key), pos[task.key], h(task.key), t.muted));
    const now = Date.now();
    for (const { pair, at } of this.links) {
      const [a, b] = pair.split("|");
      if (pos[a] && pos[b]) layers.push(this.curve(center(a), center(b), 1 - (now - at) / LINK_TTL_MS));
    }

    return div()
      .id("board")
      .relative()
      .size_full()
      .overflow_hidden()
      .bg(t.canvas)
      .when(Boolean(this.drag), (el) => el.cursor_grabbing())
      // A press on the empty board starts a selection box.
      .on_mouse_down("left", (e, cx) => {
        const at = e.local_position ?? { x: 0, y: 0 };
        this.marquee = { x0: at.x, y0: at.y, x1: at.x, y1: at.y, add: e.modifiers.shift };
        cx.notify();
      })
      .on_mouse_move((e, cx) => {
        if (this.marquee) {
          this.marquee.x1 = e.local_position.x;
          this.marquee.y1 = e.local_position.y;
          cx.notify();
          return;
        }
        if (!this.drag) return;
        this.drag.x = (e.local_position.x - ox) / z - this.drag.dx;
        this.drag.y = (e.local_position.y - oy) / z - this.drag.dy;
        cx.notify();
      })
      // Two-finger scroll pans; pinch zooms around the pointer.
      .on_scroll_wheel((e, cx) => {
        this.setView({ ...this.view, x: ox + e.delta.x, y: oy + e.delta.y }, e.touch_phase, cx);
      })
      .on_pinch((e, cx) => {
        const nz = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, z * (1 + e.delta)));
        const at = e.local_position ?? { x: 0, y: 0 };
        this.setView({ x: at.x - ((at.x - ox) / z) * nz, y: at.y - ((at.y - oy) / z) * nz, z: nz }, e.touch_phase, cx);
      })
      .on_mouse_up("left", (_e, cx) => {
        this.endMarquee(pos, h);
        this.drop(cx);
      })
      .on_hover((hovered, cx) => {
        if (hovered) return;
        this.marquee = null;
        this.drop(cx);
      })
      .when(Boolean(this.error), (el) =>
        el.child(
          div()
            .absolute()
            .left(12)
            .bottom(12)
            .px(10)
            .py(4)
            .rounded(6)
            .bg(t.raised)
            .text_size(12)
            .text_color(t.muted)
            .child(`Couldn't refresh from ${this.provider?.name} (${this.error}), showing the last tasks`)
        )
      )
      .children(layers)
      .children(
        this.tasks.flatMap((task) => [
          this.card(t, task, pos[task.key], byAgent[task.key] ?? []),
          this.agentCorner(t, task, pos[task.key], byAgent[task.key] ?? []),
        ])
      )
      .when(Boolean(this.marquee), (el) => {
        const m = this.marquee;
        return el.child(
          div()
            .absolute()
            .left(Math.min(m.x0, m.x1))
            .top(Math.min(m.y0, m.y1))
            .w(Math.abs(m.x1 - m.x0))
            .h(Math.abs(m.y1 - m.y0))
            .border(1)
            .border_color(t.accent)
            .bg(t.selected)
        );
      })
      // Last, so cards panned underneath don't cover it.
      .child(
        div()
          .absolute()
          .top(12)
          .right(12)
          .child(
            this.cardButton(
              t,
              (n) => n * 1.2,
              "refresh",
              this.loading
                ? svg("mods/project-board/refresh.svg").size(16).text_color(t.foreground).spin(900)
                : svg("mods/project-board/refresh.svg").size(16).text_color(t.foreground),
              (cx) => this.load(cx)
            )
          )
      );
  }

  // Kept per copy while gesturing; saved when the gesture ends (mouse wheels report no phase, so every notch saves).
  setView(view, phase, cx) {
    this.view = view;
    if (phase !== "moved" && phase !== "started") setShared(VIEW_KEY, view);
    cx.notify();
  }

  // Selects the cards the box touches (adding to the selection with shift); a click without a box clears it.
  endMarquee(pos, h) {
    const m = this.marquee;
    if (!m) return;
    this.marquee = null;
    const [l, r, t, b] = [Math.min(m.x0, m.x1), Math.max(m.x0, m.x1), Math.min(m.y0, m.y1), Math.max(m.y0, m.y1)];
    const w = CARD_W * this.view.z;
    const hit = this.tasks.filter((task) => {
      const p = pos[task.key];
      return p.x < r && l < p.x + w && p.y < b && t < p.y + h(task.key);
    });
    const tiny = r - l < 4 && b - t < 4;
    this.selected = new Set([...(m.add ? this.selected : []), ...(tiny ? [] : hit.map((task) => task.key))]);
  }

  drop(cx) {
    if (!this.drag) return;
    const moved = this.positions();
    const keys = [this.drag.key, ...Object.keys(this.drag.group)];
    this.drag = null;
    const saved = { ...(shared(POS_KEY) ?? {}) };
    for (const k of keys) saved[k] = { x: Math.round(moved[k].x), y: Math.round(moved[k].y) };
    setShared(POS_KEY, saved);
    cx.notify();
  }

  // No project for this space yet: a call to set one up.
  blankSlate(t) {
    return this.message(t, `Set up a project board for ${this.spaceName ?? "this space"}`,
      "See your tasks as cards, with what blocks them and the agents working on each.")
      .child(this.setupButton(t, "Set up project board"));
  }

  // Opens the setup dialog (setup.js) for this space.
  setupButton(t, label) {
    const open = () => openOverlay({ mod: "project-board", kind: "dialog", width: 440, height: 360,
      props: { variant: "setup", space: this.space, spaceName: this.spaceName } });
    return div().id("setup-board").mt(10).h(32).px(14).flex().items_center().rounded(8).cursor_pointer()
      .bg(t.solid).text_color(t.solid_foreground).text_size(13).hover((s) => s.opacity(0.9))
      .on_click(open).child(label);
  }

  message(t, title, body) {
    return v_flex()
      .size_full()
      .items_center()
      .justify_center()
      .gap(6)
      .bg(t.canvas)
      .child(div().text_color(t.foreground).child(title))
      .child(div().text_size(12).text_color(t.muted).child(body));
  }

  // Laid out like a kanban card: icon + title, ID, assignees; agent avatars hang off the bottom-right corner.
  card(t, task, p, workers) {
    const z = this.view.z;
    const u = (n) => n * z;
    const dragging = Boolean(this.drag && (this.drag.key === task.key || task.key in this.drag.group));
    const selected = this.selected.has(task.key);
    return v_flex()
      .id(`card-${task.key}`)
      .absolute()
      .left(p.x)
      .top(p.y)
      .w(u(CARD_W))
      .p(u(14))
      .gap(u(10))
      .rounded(u(10))
      .bg(t.background)
      .border(1)
      .border_color(dragging || selected ? t.accent : t.border)
      .when(!dragging && !selected, (el) => el.hover((s) => s.border_color(t.input)))
      .on_hover((hovered, cx) => {
        this.hovered = hovered ? task.key : this.hovered === task.key ? null : this.hovered;
        cx.notify();
      })
      .when(dragging, (el) => el.shadow_lg())
      .map((el) => (dragging ? el.cursor_grabbing() : el.cursor_grab()))
      .on_size_change((size, cx) => {
        if (this.heights[task.key] === size.height / z) return;
        this.heights[task.key] = size.height / z;
        cx.notify();
      })
      .on_mouse_down("left", (e, cx) => {
        cx.stop_propagation();
        if (e.modifiers.shift) {
          this.selected.has(task.key) ? this.selected.delete(task.key) : this.selected.add(task.key);
          cx.notify();
          return;
        }
        if (!this.selected.has(task.key)) this.selected = new Set([task.key]);
        const world = this.positions();
        const group = {};
        for (const k of this.selected) if (k !== task.key && world[k]) group[k] = { x: world[k].x - world[task.key].x, y: world[k].y - world[task.key].y };
        this.drag = { key: task.key, x: world[task.key].x, y: world[task.key].y, dx: e.local_position.x / z, dy: e.local_position.y / z, group };
        cx.notify();
      })
      .on_click((e, cx) => e.click_count >= 2 && this.provider?.open(task))
      .child(
        h_flex()
          .gap(u(8))
          .items_start()
          .child(div().pt(u(2)).flex_none().child(this.pageIcon(t, task.icon, u)))
          .child(div().w(u(CARD_W - 52)).text_size(u(14)).font_medium().text_color(t.foreground).child(task.title))
      )
      .child(
        h_flex()
          .gap(u(8))
          .items_center()
          .child(div().text_size(u(12)).text_color(t.dim).child(task.key))
          .when(Boolean(task.status), (el) => el.child(this.statusPill(t, u, task.status)))
      )
      .child(
        h_flex()
          .gap(u(8))
          .items_center()
          .children(
            task.people.map((person) => {
              const pic = this.cachedPath(`avatars/${person.id}${person.avatar?.match(/\.\w+$/)?.[0] ?? ""}`);
              return h_flex()
                .gap(u(6))
                .items_center()
                .child(
                  pic
                    ? image(pic).size(u(20)).rounded_full()
                    : div().size(u(20)).rounded_full().bg(t.raised).flex().items_center().justify_center().text_size(u(10)).child(person.name[0])
                )
                .child(div().text_size(u(13)).text_color(t.foreground).child(person.name));
            })
          )
      )

      // Last child, so it paints over this card's title but under any card stacked above this one.
      .when(this.hovered === task.key || dragging, (el) =>
        el.child(
          h_flex()
            .absolute()
            .top(u(8))
            .right(u(8))
            .gap(u(4))
            .child(this.cardButton(t, u, `open-${task.key}`, svg(this.provider?.icon ?? "mods/project-board/page.svg").size(u(14)).text_color(t.foreground), () => this.provider?.open(task)))
        )
      );
  }

  // Theme fills like raised/hover can be translucent: the card-colored base keeps the title from showing through.
  cardButton(t, u, id, icon, action) {
    return div()
      .id(id)
      .size(u(26))
      .rounded(u(6))
      .bg(t.background)
      .cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        action(cx);
      })
      .child(
        div()
          .id(`${id}-face`) // hover styles only apply to elements with an id
          .size_full()
          .flex()
          .items_center()
          .justify_center()
          .rounded(u(6))
          .bg(t.raised)
          .border(1)
          .border_color(t.border)
          .hover((s) => s.bg(t.input))
          .child(icon)
      );
  }

  // A Claude chat tab (herdr-chat) named after the task, so its agent shows on this card, with the bare task ID
  // (which the implement-notion-task skill picks up) typed into its composer but not sent, so the model and other
  // settings can be changed first. `chat.type` reaches only chats on screen: the new tab is focused, and its
  // chat view needs a moment to start before it can take the text.
  startAgent(task, cx) {
    const space = spaces().find((s) => s.active);
    const name = `${task.key} ${task.title}`;
    const chat = `c-${Math.random().toString(16).slice(2, 10)}`;
    run("tab.new", {
      name: name.length > 32 ? name.slice(0, 31) + "…" : name,
      space: space?.id,
      mod: "chat",
      // The space's folder: shared "space.dirs" (its menu's Folder…), else where it was made.
      props: { chat, provider: "claude", ...(space ? { cwd: shared("space.dirs")?.[space.id] || space.folder } : {}) },
    });
    cx.timer.after(800, () => run(`chat.type:${task.key}`));
  }


  // The task's status: a dot and white text on a fill, colored by stage.
  statusPill(t, u, status) {
    const [dot, fill] = STAGE_COLORS[status.stage] ?? STAGE_COLORS.progress;
    return h_flex()
      .gap(u(5))
      .items_center()
      .px(u(6))
      .py(u(0))
      .rounded_full()
      .bg(fill)
      .child(div().size(u(6)).rounded_full().bg(dot))
      .child(div().text_size(u(12)).text_color("#ffffff").child(status.name));
  }


  pageIcon(t, icon, u) {
    if (icon?.emoji) return div().text_size(u(14)).child(icon.emoji);
    const file = icon?.svg && this.cachedPath(iconFile(icon.svg));
    return svg(file ?? "mods/project-board/page.svg")
      .size(u(16))
      .text_color(t[icon?.color] ?? t.muted);
  }

  // Over the card's bottom-right corner, mostly inside it but breaking out of its edge. Drawn by the board right
  // after the card, not inside it: a card paints its border over its own contents. Cards stacked above still cover it.
  agentCorner(t, task, p, workers) {
    const z = this.view.z;
    const u = (n) => n * z;
    const dragging = Boolean(this.drag && (this.drag.key === task.key || task.key in this.drag.group));
    const n = Math.max(1, workers.length);
    const width = u(n * 22 + (n - 1) * 10);
    return h_flex()
      .absolute()
      .left(p.x + u(CARD_W) + u(5) - width)
      .top(p.y + this.height(task.key) * z + u(5) - u(22))
      .gap(u(10))
      .children(
        workers.length
          ? workers.map((a) => this.avatar(t, a, u, this.checks[task.key]))
          : shared(SESSIONS_KEY)?.[task.key]
            ? [this.closedAvatar(t, task, u)]
            : [this.startAvatar(t, task, u, dragging)]
      );
  }

  // Had a chat session that's closed now: a dashed ring, always shown; clicking resumes the session.
  closedAvatar(t, task, u) {
    return div()
      .id(`closed-${task.key}`)
      .relative()
      .size(u(22))
      .cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.resumeSession(task);
      })
      .child(div().absolute().left(u(-4.5)).top(u(-4.5)).size(u(31)).rounded_full().bg(t.background))
      .child(svg("mods/project-board/dashed-ring.svg").absolute().left(u(-6)).top(u(-6)).size(u(34)).text_color(t.idle))
      .child(
        div()
          .absolute()
          .size_full()
          .rounded_full()
          .bg(mix(t.idle, t.background, 0.25))
          .flex()
          .items_center()
          .justify_center()
          .child(image("icons/claude.svg").size(u(12)))
      );
  }

  // No agent yet: a dotted avatar that starts one. Hidden until the card or the avatar itself is hovered; the
  // avatar hangs outside the card, where hovering it doesn't count as hovering the card.
  startAvatar(t, task, u, dragging) {
    const shown = dragging || this.hovered === task.key || this.startHovered === task.key;
    return div()
      .id(`start-${task.key}`)
      .relative()
      .size(u(22))
      .flex()
      .items_center()
      .justify_center()
      .rounded_full()
      .bg(t.background)
      .cursor_pointer()
      .opacity(shown ? 1 : 0)
      .on_hover((hovered, cx) => {
        this.startHovered = hovered ? task.key : this.startHovered === task.key ? null : this.startHovered;
        cx.notify();
      })
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.startAgent(task, cx);
      })
      .child(svg("mods/project-board/dotted-ring.svg").absolute().size_full().text_color(t.muted))
      .child(image("icons/claude.svg").size(u(12)));
  }

  // The ring shows the most pressing of: working (yellow spinner), starting (grey spinner), blocked, then the task's
  // PR checks: failed (red ring), running (blue spinner), passed (green ring); else the agent's status.
  avatar(t, a, u, checks) {
    const [color, spinning] =
      a.status === "working" ? [t.working, true]
      : a.status === "starting" ? [t.idle, true]
      : a.status === "blocked" ? [t.blocked, false]
      : checks === "failed" ? [t.ansi1, false]
      : checks === "pending" ? [t.ansi4, true]
      : checks === "passed" ? [t.ansi2, false]
      : [t[a.status] ?? t.accent, false];
    const icon = a.program.icon ? (a.program.tint ? svg(a.program.icon).size(u(12)).text_color(color) : image(a.program.icon).size(u(12))) : a.program.name[0];
    return div()
      .id(`av-${a.address}`)
      .relative()
      .size(u(22))
      .cursor_pointer()
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      // As the agents list does: focusing the agent's pane shows its tab (a chat's, for chat sessions).
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run("pane.focus", { pane: a.pane });
      })
      // Solid backing out to the ring's outer edge, so nothing behind shows between the ring and the avatar.
      .child(div().absolute().left(u(-4.5)).top(u(-4.5)).size(u(31)).rounded_full().bg(t.background))
      // A spinner, or a full ring of the same size and width. Sized so the inner edge clears the 22px avatar.
      .child(
        spinning
          ? svg("mods/workspace-chrome/spinner.svg").absolute().left(u(-6)).top(u(-6)).size(u(34)).text_color(color).spin(900).loop("opacity", { from: 0.97, to: 1, period: 1000 })
          : svg("mods/project-board/ring.svg").absolute().left(u(-6)).top(u(-6)).size(u(34)).text_color(color)
      )
      // A dark tint of the status color, mixed into one opaque color.
      .child(div().absolute().size_full().rounded_full().bg(mix(color, t.background, 0.25)))
      .child(
        div().absolute().size_full().flex().items_center().justify_center().text_size(u(11)).text_color(color).child(icon)
      );
  }

  // Orthogonal elbow: leaves the blocker's facing side, turns at the midpoint, enters the blocked card.
  arrow(from, fromH, to, toH, color) {
    const z = this.view.z;
    const CARD_W_PX = CARD_W * z;
    const right = to.x + CARD_W_PX / 2 >= from.x + CARD_W_PX / 2;
    const sx = right ? from.x + CARD_W_PX : from.x;
    const tx = right ? to.x : to.x + CARD_W_PX;
    const sy = from.y + fromH / 2;
    const ty = to.y + toH / 2;
    const mx = (sx + tx) / 2;
    const dir = right ? 1 : -1;
    const line = PathBuilder.stroke(Math.max(1, 1.5 * z)).move_to(sx, sy).line_to(mx, sy).line_to(mx, ty).line_to(tx, ty).build();
    const head = PathBuilder.fill()
      .add_polygon([[tx, ty], [tx - dir * 8 * z, ty - 5 * z], [tx - dir * 8 * z, ty + 5 * z]], true)
      .build();
    return div().absolute().inset_0().child(window.paint_path(line, color)).child(window.paint_path(head, color));
  }

  // Bowed curve between card centres; fades as the message ages.
  curve(a, b, strength) {
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    const bow = 0.25;
    const cx = mx - (b.y - a.y) * bow;
    const cy = my + (b.x - a.x) * bow;
    const path = PathBuilder.stroke(Math.max(1, 2.5 * this.view.z)).move_to(a.x, a.y).curve_to(b.x, b.y, cx, cy).build();
    return div().absolute().inset_0().child(window.paint_path(path, Background.solid(GREEN).opacity(0.25 + 0.75 * strength)));
  }
}

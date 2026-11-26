// The agent's task in the context panel (agents-sidebar-context-panel): a card in Summary drawn like the board's,
// and a Task tab with the whole Notion page, editable: title, properties and the page's text.
// The task is the ID (OI-42) in the agent's tab, pane, branch or space name, looked up in a project board's
// databases (the agent's space's first, then any other space's). Registered when main.js loads, which the
// panel's 1px loader window is enough for. Notion only, as that's the only provider.
//
// Editing: click text to edit it, click away to save. Text is edited as Markdown (**bold**, *italic*, ~~strike~~,
// `code`, [link](url)); text Markdown can't hold without losing something (a mention, a color) is shown but
// left to Notion. A block edited to empty is deleted. Relations, files and rollups are read-only. Page comments are
// listed under the text, oldest first, with one box under them: a comment continues the latest thread (or starts
// one) and is posted under the name of whoever connected Notion. Comments on blocks aren't shown.
import { div, svg, image } from "gpui-kit";
import { h_flex, v_flex, CalendarState, Input, InputState, Popover, Textarea, TextareaState, TextView } from "gpui-base";
import { appHome, checking, exec, panes, settings, spaces } from "herdr";
import provider, { ICON_COLORS, keyOf, notion, readToken, toTask } from "./providers/notion.js";
import { readConfig } from "./setup.js";

const MOD = "project-board";
const TASK_ID = /\b([A-Z]{2}-\d+)\b/i;
const POLL = 60_000;
const CACHE = "mods/project-board/.cache"; // the board's, so icons and avatars it downloaded are reused
// Status pill colors, [dot, fill], by the status's stage.
export const STAGE_COLORS = { queued: ["#D0A548", "#836A35"], progress: ["#4481D8", "#45699B"], done: ["#5F9F75", "#486A52"] };
const TEXT_BLOCKS = ["paragraph", "heading_1", "heading_2", "heading_3", "bulleted_list_item", "numbered_list_item", "to_do", "quote", "callout", "toggle", "code"];
// Typed at the start of a new block, its type (as Notion does).
const SHORTCUTS = [["### ", "heading_3"], ["## ", "heading_2"], ["# ", "heading_1"], ["- ", "bulleted_list_item"], ["* ", "bulleted_list_item"],
  ["1. ", "numbered_list_item"], ["[] ", "to_do"], ["> ", "quote"]];

// The task's status: a dot and white text on a fill, colored by stage. u scales (the board's zoom).
export function statusPill(t, u, status) {
  const [dot, fill] = STAGE_COLORS[status.stage] ?? STAGE_COLORS.progress;
  return h_flex().gap(u(5)).items_center().px(u(6)).rounded_full().bg(fill)
    .child(div().size(u(6)).rounded_full().bg(dot))
    .child(div().text_size(u(12)).text_color("#ffffff").child(status.name));
}

// ---- Rich text <-> Markdown ----
// A run: { text, bold, italic, strike, code, link }. Adjacent runs with the same formatting are merged.

const same = (a, b) => a.bold === b.bold && a.italic === b.italic && a.strike === b.strike && a.code === b.code && a.link === b.link;
const pushRun = (runs, run) => {
  if (!run.text) return;
  const last = runs.at(-1);
  if (last && same(last, run)) last.text += run.text;
  else runs.push(run);
};

// Notion rich text as runs, or null when it has what runs can't hold (a mention, an equation, a color, underline).
export function runsOf(rich = []) {
  const runs = [];
  for (const r of rich) {
    const a = r.annotations ?? {};
    if (r.type !== "text" || a.underline || (a.color && a.color !== "default")) return null;
    pushRun(runs, { text: r.plain_text, bold: !!a.bold, italic: !!a.italic, strike: !!a.strikethrough, code: !!a.code, link: r.text.link?.url ?? null });
  }
  return runs;
}

export const toMd = (runs) => runs.map((r) => {
  let s = r.code ? `\`${r.text}\`` : r.text;
  if (r.link) s = `[${s}](${r.link})`;
  if (r.strike) s = `~~${s}~~`;
  if (r.italic) s = `*${s}*`;
  if (r.bold) s = `**${s}**`;
  return s;
}).join("");

const MD = /\*\*|~~|\*|`([^`]*)`|\[([^\]]*)\]\(([^)\s]+)\)/g;
// A marker left open (a lone *) makes the whole text plain, so it isn't swallowed.
export function fromMd(md) {
  const runs = [];
  const f = { bold: false, italic: false, strike: false };
  const push = (text, extra) => pushRun(runs, { text, ...f, code: false, link: null, ...extra });
  let i = 0;
  for (const m of md.matchAll(MD)) {
    push(md.slice(i, m.index));
    i = m.index + m[0].length;
    if (m[0] === "**") f.bold = !f.bold;
    else if (m[0] === "*") f.italic = !f.italic;
    else if (m[0] === "~~") f.strike = !f.strike;
    else if (m[1] !== undefined) push(m[1], { code: true });
    else push(m[2], { link: m[3] });
  }
  push(md.slice(i));
  return f.bold || f.italic || f.strike ? (md ? [{ text: md, bold: false, italic: false, strike: false, code: false, link: null }] : []) : runs;
}

// The Markdown to edit rich text as, or null when saving it back would lose something.
export function editableMd(rich) {
  const runs = runsOf(rich);
  if (!runs) return null;
  const md = toMd(runs);
  return JSON.stringify(fromMd(md)) === JSON.stringify(runs) ? md : null;
}

// Runs as Notion rich text, split into Notion's 2000-character pieces.
const toRich = (runs) => runs.flatMap((r) => (r.text.match(/[\s\S]{1,2000}/g) ?? []).map((content) => ({
  type: "text", text: { content, link: r.link ? { url: r.link } : null },
  annotations: { bold: r.bold, italic: r.italic, strikethrough: r.strike, code: r.code, underline: false, color: "default" },
})));
const plain = (rich = []) => rich.map((r) => r.plain_text).join("");
const plainRich = (text) => toRich(text ? [{ text, bold: false, italic: false, strike: false, code: false, link: null }] : []);

// ---- Loading ----

const entries = new Map(); // task key -> { key, at, busy, error, missing, token, page, task, schema, blocks, saving }
const related = new Map(); // page id -> { key, title } | "loading"
let users = null; // the workspace's people, once listed: [{ id, name, avatar }]
let usersAsked = false;
let editing = null; // the one open editor: { id, state }; nothing refetches while it's open
let composer = null; // the comment box, while open: { key, state }; nor while this is

// The task ID for ctx's agent, and its space.
function found(ctx) {
  const tab = ctx.tab ?? ctx.agent?.tab;
  const space = spaces().find((s) => s.tabs.some((tb) => tb.id === tab));
  const names = [space?.tabs.find((tb) => tb.id === tab)?.name, ...panes().filter((p) => p.tab === tab).flatMap((p) => [p.name, p.title, p.branch]),
    ctx.branch, space?.branch, space?.name];
  const m = names.map((s) => TASK_ID.exec(s ?? "")).find(Boolean);
  return m ? { key: m[1].toUpperCase(), space: space?.id } : null;
}

// The cached task for ctx's agent (null before the first answer), fetched again when stale. Called from render.
function load(ctx) {
  const f = found(ctx);
  if (!f) return null;
  let e = entries.get(f.key);
  if (!e) entries.set(f.key, (e = { key: f.key, at: 0, saving: 0 }));
  if (!e.busy && !e.saving && !editing && !composer && !e.comments?.some((c) => c.pending) && !checking() && Date.now() - e.at > POLL) {
    e.busy = true;
    ctx.cx.spawn(async (cx) => {
      try {
        Object.assign(e, await fetchTask(f), { error: null });
      } catch (err) {
        e.error = String(err?.message ?? err);
      }
      e.at = Date.now();
      e.busy = false;
      cx.notify();
    });
  }
  return e.at ? e : null;
}

async function fetchTask({ key, space }) {
  const { all } = await readConfig();
  const configs = [all[space], ...Object.values(all)].filter((c, i, a) => c?.provider === "notion" && a.indexOf(c) === i);
  for (const config of configs) {
    const page = await provider.find(config, key);
    if (!page) continue;
    const token = await readToken(config);
    const source = page.parent?.data_source_id;
    const [schema, blocks, comments] = await Promise.all([source ? notion(token, `data_sources/${source}`) : null, children(token, page.id, 0),
      // Needs the connection's comment capability: without it, say so rather than fail the page.
      allComments(token, page.id).catch((err) => ({ error: String(err?.message ?? err) }))]);
    return { missing: false, token, me: config.assignee, page, task: toTask(page), schema: schema?.properties ?? {}, blocks,
      comments: Array.isArray(comments) ? comments : [], commentsError: comments.error ?? null };
  }
  return { missing: true, page: null };
}

async function allComments(token, id) {
  const out = [];
  for (let cursor; ;) {
    const json = await notion(token, `comments?block_id=${id}&page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    out.push(...json.results);
    if (!json.has_more) return out;
    cursor = json.next_cursor;
  }
}

// The workspace's people, listed once (for the people dropdown and comment authors).
function loadUsers(cx, token) {
  if (usersAsked || checking()) return;
  usersAsked = true;
  cx.spawn(async (cx) => {
    const json = await notion(token, "users?page_size=100").catch(() => ({ results: [] }));
    users = json.results.filter((u) => u.type === "person").map((u) => ({ id: u.id, name: u.name, avatar: u.avatar_url }));
    cx.notify();
  });
}

// A block's children, nested ones included (to a depth of 3).
async function children(token, id, depth) {
  const out = [];
  for (let cursor; ;) {
    const json = await notion(token, `blocks/${id}/children?page_size=100${cursor ? `&start_cursor=${cursor}` : ""}`);
    out.push(...json.results);
    if (!json.has_more) break;
    cursor = json.next_cursor;
  }
  await Promise.all(out.filter((b) => b.has_children && depth < 3 && !["child_page", "child_database"].includes(b.type))
    .map(async (b) => { b.children = await children(token, b.id, depth + 1); }));
  return out;
}

// Runs work (a Notion write) with the task marked saving; a failure shows, and the task is fetched again.
function save(e, cx, work) {
  e.saving++;
  cx.notify();
  cx.spawn(async (cx) => {
    try {
      await work();
      e.error = null;
    } catch (err) {
      e.error = `Couldn't save: ${err?.message ?? err}`;
      e.at = 1;
    }
    e.saving--;
    cx.notify();
  });
}

const setProp = (e, cx, name, value) => save(e, cx, async () => {
  e.page = await notion(e.token, `pages/${e.page.id}`, { properties: { [name]: value } }, "PATCH");
  e.task = toTask(e.page);
});

// Opens a text editor in place of the text with id; it saves (if changed) when it loses focus.
function edit(id, value, multi, onSave, cx) {
  if (editing) editing.state.blur();
  const state = multi ? TextareaState.new({ value }) : InputState.new({ value });
  if (multi) state.set_auto_grow(1, 30);
  state.on("blur", (_e, cx) => {
    if (editing?.state !== state) return;
    editing = null;
    const next = state.value();
    Promise.resolve().then(() => state.release());
    if (next !== value) onSave(next, cx);
    cx.notify();
  });
  if (!multi) state.on("submit", () => state.blur());
  editing = { id, state };
  state.focus();
  cx.notify();
}

// Text and its editor share one box (padding, font, line height) and the editor draws no frame of its own, so the
// text stays put when editing starts. look: { size, bold, mono, bg } for the text inside.
const lineHeight = (size) => `${Math.round(size * 1.5)}px`;
const textBox = (t, el, multi, look = {}) => el.w_full().px(look.mono ? 8 : 4).py(look.mono ? 8 : multi ? 3 : 0)
  .when(!multi, (el) => el.min_h(28)).rounded(look.mono ? 6 : 4)
  .text_size(look.size ?? 13).line_height(lineHeight(look.size ?? 13)).when(Boolean(look.bold), (el) => el.font_semibold())
  .when(Boolean(look.mono), (el) => el.font_family(String(settings().font_family ?? "Menlo")))
  .when(Boolean(look.bg), (el) => el.bg(look.bg));
const editor = (t, multi, look) => textBox(t, multi ? Textarea.new(editing.state) : Input.new(editing.state), multi, look)
  .when(!multi, (el) => el.h(28)).bg(look?.bg ?? t.hover);

// ---- Pieces ----

// Downloads into the board's cache once; the path once it's there.
const files = new Map(); // name -> true | false | "busy"
function cached(cx, url, name) {
  if (!url) return null;
  if (!files.has(name) && !checking()) {
    files.set(name, "busy");
    cx.spawn(async (cx) => {
      const r = await exec("sh", ["-c", 'test -s "$1" || curl -sfL --create-dirs -o "$1" "$2"', "_", `${appHome()}/${CACHE}/${name}`, url]).catch(() => null);
      files.set(name, r?.code === 0);
      cx.notify();
    });
  }
  return files.get(name) === true ? `${CACHE}/${name}` : null;
}

function pageIcon(ctx, icon, size = 16) {
  if (icon?.emoji) return div().text_size(size - 2).child(icon.emoji);
  const file = icon?.svg && cached(ctx.cx, icon.svg, `icons/${icon.svg.split("/").pop()}`);
  return svg(file ?? "mods/project-board/page.svg").size(size).text_color(ctx.t[icon?.color] ?? ctx.t.muted);
}

function person(ctx, p, size = 20) {
  const pic = cached(ctx.cx, p.avatar ?? p.avatar_url, `avatars/${p.id}${(p.avatar ?? p.avatar_url)?.match(/\.\w+$/)?.[0] ?? ""}`);
  return h_flex().gap(6).items_center().flex_none()
    .child(pic ? image(pic).size(size).rounded_full()
      : div().size(size).rounded_full().bg(ctx.t.raised).flex().items_center().justify_center().text_size(size / 2).child((p.name ?? "?")[0]))
    .child(div().text_size(13).text_color(ctx.t.foreground).child(p.name ?? "Unknown"));
}

const colorOf = (t, color) => t[ICON_COLORS[color]] ?? t.muted;
const pill = (t, name, color) => h_flex().gap(5).items_center().px(6).rounded_full().bg(t.raised).flex_none()
  .child(div().size(6).rounded_full().bg(colorOf(t, color)))
  .child(div().text_size(12).text_color(t.foreground).child(name));
const muted = (t, text) => div().text_size(13).text_color(t.dim).child(text);
const msg = (t, text, color = t.muted) => div().px(4).py(6).text_size(12.5).text_color(color).child(text);
// A turning ring beside the text. The near-invisible opacity loop keeps it repainting smoothly (as github-pr's does).
const spinning = (t, text) => h_flex().px(4).py(6).gap(8).items_center().text_size(12.5).text_color(t.muted)
  .child(svg("mods/workspace-chrome/spinner.svg").size(14).flex_none().text_color(t.muted).spin(900).loop("opacity", { from: 0.97, to: 1, period: 1000 }))
  .child(text);

// The board's card: icon and title, ID and status, assignees.
function card(ctx, e) {
  const { t } = ctx;
  const task = e.task;
  return v_flex().id("task-card").relative().mt(4).p(14).gap(10).rounded(10).bg(t.background).border(1).border_color(t.border)
    .cursor_pointer().hover((s) => s.border_color(t.input))
    .on_hover((hovered, cx) => { ctx.state.cardHover = hovered; cx.notify(); })
    .on_click((_e, cx) => { ctx.show(MOD); cx.notify(); })
    .child(h_flex().gap(8).items_start()
      .child(div().pt(2).flex_none().child(pageIcon(ctx, task.icon)))
      .child(div().flex_1().min_w(0).text_size(14).font_medium().text_color(t.foreground).child(task.title)))
    .child(h_flex().gap(8).items_center()
      .child(div().text_size(12).text_color(t.dim).child(task.key))
      .when(Boolean(task.status), (el) => el.child(statusPill(t, (n) => n, task.status))))
    .when(task.people.length > 0, (el) => el.child(h_flex().gap(8).flex_wrap().children(task.people.map((p) => person(ctx, p)))))
    // Last, so it paints over the title, as on the board.
    .when(Boolean(ctx.state.cardHover), (el) => el.child(div().absolute().top(8).right(8).child(openButton(t, e, "card-open"))));
}

// Opens the task in Notion. The card-colored base keeps text behind from showing through a translucent hover.
const openButton = (t, e, id) => div().id(id).size(26).rounded(6).bg(t.background).cursor_pointer()
  .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
  .on_click((_e, cx) => { cx.stop_propagation(); provider.open(e.task); })
  .child(div().id(`${id}-face`).size_full().flex().items_center().justify_center().rounded(6).bg(t.raised).border(1).border_color(t.border)
    .hover((s) => s.bg(t.input)).tooltip("Open in Notion").child(svg(provider.icon).size(14).text_color(t.foreground)));

// ---- The page ----

// Text that turns into an editor when clicked. md null: shown, not editable.
function editableText(ctx, e, id, md, shown, multi, onSave, look) {
  const { t } = ctx;
  if (editing?.id === id) return editor(t, multi, look);
  const el = textBox(t, (multi ? div() : h_flex().items_center()).id(id).flex_1().min_w(0), multi, look).child(shown);
  if (md == null) return el;
  return el.cursor_text().hover((s) => s.bg(t.hover))
    .on_click((_e, cx) => edit(id, md, multi, (v, cx) => onSave(v, cx), cx));
}

function title(ctx, e) {
  const { t } = ctx;
  const [name, prop] = Object.entries(e.page.properties).find(([, p]) => p.type === "title") ?? [];
  const md = name ? editableMd(prop.title) : null;
  return h_flex().gap(8).items_start()
    .child(div().pt(5).flex_none().child(pageIcon(ctx, e.task.icon, 18)))
    .child(editableText(ctx, e, "task-title", md, div().text_color(t.foreground).child(e.task.title || "Untitled"), false,
      (v, cx) => setProp(e, cx, name, { title: toRich(fromMd(v)) }), { size: 17, bold: true }))
    .child(div().flex_none().child(openButton(t, e, "task-open")));
}

// A dropdown of options (null while they load); pick(option, cx). multi keeps it open to pick more.
function picker(ctx, id, trigger, options, pick, multi = false) {
  const { t, state } = ctx;
  return Popover.new(id).anchor("top_left").open(state.open === id)
    .on_open_change((open, cx) => { state.open = open ? id : null; cx.notify(); })
    .trigger(trigger)
    .content(div().pt(4).child(v_flex().id(`${id}-list`).w(220).max_h(320).overflow_y_scrollbar().p(4).gap(2).rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_lg()
      .when(!options?.length, (el) => el.child(options ? msg(t, "No options") : spinning(t, "Loading…")))
      .children((options ?? []).map((o, i) => h_flex().id(`${id}-${i}`).h(28).px(8).gap(8).rounded(6).items_center().cursor_pointer()
        .when(Boolean(o.on), (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => { if (!multi) state.open = null; pick(o, cx); cx.notify(); })
        .child(o.view)))));
}

const valueBox = (t, id) => h_flex().id(id).flex_1().min_w(0).min_h(28).px(4).gap(6).flex_wrap().items_center().rounded(4).cursor_pointer().hover((s) => s.bg(t.hover));

// A value's first line is the key's 28px row, so the two line up at the top.
const line = (el) => h_flex().min_h(28).px(4).items_center().child(el);

// One property's value, editable where Notion's API allows.
function propValue(ctx, e, name, p) {
  const { t } = ctx;
  const id = `prop-${p.id}`;
  const v = p[p.type];
  const set = (value, cx) => setProp(e, cx, name, { [p.type]: value });
  const options = () => e.schema[name]?.[p.type]?.options ?? [];
  const textProp = (shown, md, toValue) => editableText(ctx, e, id, md, div()
    .child(shown || muted(t, "Empty")), false, (s, cx) => {
    try { set(toValue(s.trim()), cx); } catch (err) { e.error = String(err?.message ?? err); }
  });
  switch (p.type) {
    case "status":
    case "select":
      return picker(ctx, id, valueBox(t, `${id}-box`).child(v ? pill(t, v.name, v.color) : muted(t, "Empty")),
        [...(p.type === "select" && v ? [{ view: muted(t, "Clear"), clear: true }] : []),
          ...options().map((o) => ({ ...o, on: o.name === v?.name, view: pill(t, o.name, o.color) }))],
        (o, cx) => { p[p.type] = o.clear ? null : o; set(o.clear ? null : { name: o.name }, cx); });
    case "multi_select":
      return picker(ctx, id, valueBox(t, `${id}-box`).children(v.length ? v.map((o) => pill(t, o.name, o.color)) : [muted(t, "Empty")]),
        options().map((o) => ({ ...o, on: v.some((x) => x.name === o.name), view: pill(t, o.name, o.color) })),
        (o, cx) => {
          p.multi_select = o.on ? v.filter((x) => x.name !== o.name) : [...v, o];
          set(p.multi_select.map((x) => ({ name: x.name })), cx);
        }, true);
    case "people": {
      if (ctx.state.open === id) loadUsers(ctx.cx, e.token);
      return picker(ctx, id, valueBox(t, `${id}-box`).children(v.length ? v.map((u) => person(ctx, u, 18)) : [muted(t, "Empty")]),
        users && users.map((u) => ({ ...u, on: v.some((x) => x.id === u.id), view: person(ctx, u, 18) })),
        (u, cx) => {
          p.people = u.on ? v.filter((x) => x.id !== u.id) : [...v, u];
          set(p.people.map((x) => ({ id: x.id })), cx);
        }, true);
    }
    case "checkbox":
      return valueBox(t, id).on_click((_e, cx) => { p.checkbox = !v; set(!v, cx); }).child(checkbox(t, v));
    case "rich_text": {
      const md = editableMd(v);
      return textProp(md ?? plain(v), md, (s) => toRich(fromMd(s)));
    }
    case "number":
      return textProp(v == null ? "" : String(v), v == null ? "" : String(v), (s) => {
        if (s && !Number.isFinite(Number(s))) throw new Error(`${s} isn't a number`);
        return s ? Number(s) : null;
      });
    case "url":
    case "email":
    case "phone_number":
      return textProp(v ?? "", v ?? "", (s) => s || null);
    case "date":
      return datePicker(ctx, id, v, (date, cx) => { p.date = date; set(date && { start: date.start, end: date.end }, cx); });
    case "relation":
      return h_flex().flex_1().min_w(0).min_h(28).px(4).gap(6).flex_wrap().items_center()
        .children(v.length ? v.map((r) => relatedPage(ctx, e, r.id)) : [muted(t, "Empty")]);
    case "unique_id":
      return line(muted(t, `${v.prefix ? `${v.prefix}-` : ""}${v.number}`));
    default:
      return line(muted(t, readOnly(p)));
  }
}

// Written out by hand: the runtime ignores toLocale*'s options. Times are the stored wall time in its own offset.
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const clock = (s) => {
  const h = Number(s.slice(11, 13));
  return `${h % 12 || 12}:${s.slice(14, 16)} ${h < 12 ? "AM" : "PM"}`;
};
// "Nov 25, 2026", with "9:23 AM" when it has a time; a range as "start → end".
function dateText(v) {
  const one = (s) => {
    const [y, m, d] = s.slice(0, 10).split("-").map(Number);
    return `${MONTHS[m - 1].slice(0, 3)} ${d}, ${y}${s.length > 10 ? ` ${clock(s)}` : ""}`;
  };
  return v.end ? `${one(v.start)} → ${one(v.end)}` : one(v.start);
}
// "9:23 AM", "9:23am" or "21:23" as "HH:MM", or null.
function parseTime(text) {
  const m = /^\s*(\d{1,2}):(\d{2})\s*(am|pm)?\s*$/i.exec(text);
  if (!m || Number(m[2]) > 59) return null;
  let h = Number(m[1]);
  if (m[3]) {
    if (h < 1 || h > 12) return null;
    h = (h % 12) + (m[3].toLowerCase() === "pm" ? 12 : 0);
  } else if (h > 23) return null;
  return `${String(h).padStart(2, "0")}:${m[2]}`;
}

// A date as a month calendar in a dropdown, with a time field when it has a time. Picking a day keeps the time
// and a range's end (when still after it). Its states are made when it opens (not in render), freed when it closes.
function datePicker(ctx, id, v, set) {
  const { t, state } = ctx;
  const cal = state.cal?.id === id ? state.cal : null;
  const timed = (v?.start?.length ?? 0) > 10;
  // The value with day (default: the current one) and the time field's time.
  const commit = (day, cx) => {
    let start = day + (v?.start?.slice(10) ?? "");
    if (timed && cal?.time) {
      const hhmm = parseTime(cal.time.value());
      if (!hhmm) { state.timeError = true; return cx.notify(); }
      start = `${day}T${hhmm}:00.000${v.start.slice(19).replace(/^\.\d+/, "")}`;
    }
    state.timeError = false;
    if (start !== v?.start) set({ start, end: v?.end && v.end.slice(0, 10) >= day ? v.end : null }, cx);
    cx.notify();
  };
  const close = () => {
    const c = state.cal;
    state.cal = null;
    state.open = null;
    state.timeError = false;
    if (c) Promise.resolve().then(() => { c.state.release(); c.time?.release(); });
  };
  return Popover.new(id).anchor("top_left").open(state.open === id && Boolean(cal))
    .on_open_change((open, cx) => {
      if (!open) {
        if (cal?.time && v) commit(v.start.slice(0, 10), cx); // a time typed but not entered still counts
        close();
      } else {
        if (state.cal) close();
        const c = CalendarState.new();
        const day = v?.start?.slice(0, 10);
        if (day) {
          c.set_value(day);
          const at = Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7));
          for (let i = 0; i < 1200 && c.year() * 12 + c.month() !== at; i++) c.year() * 12 + c.month() < at ? c.next_month() : c.prev_month();
        }
        const time = timed ? InputState.new({ value: clock(v.start), placeholder: "9:00 AM" }) : null;
        time?.on("submit", (_e, cx) => commit(v.start.slice(0, 10), cx));
        state.cal = { id, state: c, time };
        state.open = id;
      }
      cx.notify();
    })
    .trigger(valueBox(t, `${id}-box`).child(v ? div().text_size(13).text_color(t.foreground).child(dateText(v)) : muted(t, "Empty")))
    .content(cal ? div().pt(4).child(calendar(t, id, cal, v, state.timeError,
      (day, cx) => { commit(day, cx); if (!state.timeError) close(); cx.notify(); },
      (cx) => { close(); set(null, cx); cx.notify(); })) : div());
}

function calendar(t, id, { state: cal, time }, v, timeError, pick, clear) {
  const grid = cal.month_days()[0] ?? [];
  const chosen = v?.start?.slice(0, 10);
  const today = cal.today();
  const month = `${cal.year()}-${String(cal.month()).padStart(2, "0")}`;
  const weekday = (day) => "SMTWTFS"[new Date(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))).getDay()];
  const step = (key, glyph, go) => div().id(`${id}-${key}`).size(26).flex().items_center().justify_center().rounded(6).cursor_pointer()
    .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
    .on_click((_e, cx) => { go(); cx.notify(); }).child(glyph);
  const cell = (day) => div().id(`${id}-${day}`).size(28).flex().items_center().justify_center().rounded(6).cursor_pointer().text_size(12.5)
    .text_color(day === chosen ? t.accent_foreground : day.startsWith(month) ? t.foreground : t.dim)
    .when(day === chosen, (el) => el.bg(t.accent))
    .when(day !== chosen, (el) => el.hover((s) => s.bg(t.hover)))
    .when(day === today && day !== chosen, (el) => el.border_1().border_color(t.input))
    .on_click((_e, cx) => pick(day, cx))
    .child(String(Number(day.slice(8))));
  return v_flex().w(212).p(8).gap(2).rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_lg().text_color(t.foreground)
    .child(h_flex().pb(4).items_center()
      .child(step("prev", "‹", () => cal.prev_month()))
      .child(div().flex_1().text_center().text_size(13).font_medium().child(`${MONTHS[cal.month() - 1]} ${cal.year()}`))
      .child(step("next", "›", () => cal.next_month())))
    .child(h_flex().children((grid[0] ?? []).map((day) => div().size(28).flex().flex_none().items_center().justify_center().text_size(11).text_color(t.dim)
      .child(weekday(day)))))
    .children(grid.map((week) => h_flex().children(week.map(cell))))
    .child(h_flex().pt(6).gap(6).items_center()
      .when(Boolean(time), (el) => el
        .child(div().text_size(12.5).text_color(t.muted).child("Time"))
        .child(Input.new(time).w(90).h(26).px(6).rounded(6).border_1().border_color(timeError ? t.blocked : t.input).bg(t.background).text_size(12.5)))
      .child(div().flex_1())
      .when(Boolean(v), (el) => el.child(div().id(`${id}-clear`).h(26).px(8).flex().items_center().rounded(6).cursor_pointer().text_size(12.5)
        .text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => clear(cx)).child("Clear"))));
}

// Read-only dates and times, as dateText writes them (in this computer's time zone).
const isoLocal = (s) => {
  const d = new Date(s);
  const n = (x) => String(x).padStart(2, "0");
  return `${d.getFullYear()}-${n(d.getMonth() + 1)}-${n(d.getDate())}T${n(d.getHours())}:${n(d.getMinutes())}`;
};

// What a read-only property shows.
function readOnly(p) {
  const v = p[p.type];
  if (v == null) return "";
  switch (p.type) {
    case "formula": return String(v[v.type]?.start ?? v[v.type] ?? "");
    case "rollup": return v.type === "array" ? `${v.array.length} items` : String(v[v.type]?.start ?? v[v.type] ?? "");
    case "created_by": case "last_edited_by": return v.name ?? "";
    case "files": return v.map((f) => f.name).join(", ");
    case "created_time": case "last_edited_time": return dateText({ start: isoLocal(v) });
    default: return typeof v === "string" ? v : "";
  }
}

// A related page as its ID and title, fetched once.
function relatedPage(ctx, e, id) {
  const r = related.get(id);
  if (!r && !checking()) {
    related.set(id, "loading");
    ctx.cx.spawn(async (cx) => {
      try {
        const page = await notion(e.token, `pages/${id}`);
        const task = toTask(page);
        related.set(id, { key: keyOf(page), title: task.title, task });
      } catch {
        related.set(id, { key: "?", title: "Can't see this page" });
      }
      cx.notify();
    });
  }
  const { t } = ctx;
  const known = r && r !== "loading";
  return h_flex().id(`rel-${id}`).gap(6).px(6).rounded(6).bg(t.raised).items_center().max_w(260)
    .when(Boolean(known?.task), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(() => provider.open(r.task)))
    .child(div().text_size(12).text_color(t.dim).flex_none().child(known ? r.key : "…"))
    .when(Boolean(known), (el) => el.child(div().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(r.title)));
}

function checkbox(t, on) {
  return div().size(16).flex().flex_none().items_center().justify_center().rounded(4).border_1()
    .border_color(on ? t.accent : t.input).when(on, (el) => el.bg(t.accent))
    .when(on, (el) => el.child(div().text_size(11).text_color(t.accent_foreground).child("✓")));
}

// Types this panel can give a value (the rest are read-only), so an empty one can be added.
const EDITABLE = ["status", "select", "multi_select", "people", "checkbox", "rich_text", "number", "url", "email", "phone_number", "date"];
function isEmpty(p) {
  const v = p[p.type];
  if (p.type === "formula") return v?.[v.type] == null || v[v.type] === "";
  if (p.type === "rollup") return v?.type === "array" ? !v.array.length : v?.[v?.type] == null;
  return v == null || v === "" || v === false || (Array.isArray(v) && !v.length);
}

// Properties with a value, and empty ones added this time (state.added); the rest behind Add property.
function properties(ctx, e) {
  const { t, state } = ctx;
  state.added ??= new Set();
  const all = Object.entries(e.page.properties).filter(([, p]) => p.type !== "title");
  // One being edited stays if it's emptied (its last option removed, say), while this panel is open.
  for (const [name, p] of all) if (state.open === `prop-${p.id}` || editing?.id === `prop-${p.id}`) state.added.add(name);
  const shown = all.filter(([name, p]) => !isEmpty(p) || state.added.has(name));
  const addable = all.filter(([name, p]) => isEmpty(p) && !state.added.has(name) && EDITABLE.includes(p.type));
  const add = ([name, p], cx) => {
    state.added.add(name);
    // Its own dropdown opens at once; text waits for a click on Empty.
    if (["status", "select", "multi_select", "people"].includes(p.type)) ctx.cx.timer.after(50, (cx) => { state.open = `prop-${p.id}`; cx.notify(); });
  };
  return v_flex().gap(2)
    .children(shown.map(([name, p]) => h_flex().gap(8).items_start()
      .child(h_flex().w(110).h(28).flex_none().items_center().child(div().min_w(0).truncate().text_size(12.5).text_color(t.muted).child(name)))
      .child(div().flex_1().min_w(0).child(propValue(ctx, e, name, p)))))
    .when(addable.length > 0, (el) => el.child(h_flex().pt(6).child(picker(ctx, "add-property",
      h_flex().id("add-property-button").h(28).px(10).gap(6).items_center().rounded(6).border_1().border_color(t.input)
        .cursor_pointer().text_size(12.5).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).child("+ Add property"),
      addable.map(([name, p]) => ({ name, p, view: div().text_size(13).child(name) })),
      (o, cx) => add([o.name, o.p], cx)))));
}

// ---- Blocks ----

function findBlock(list, id) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return [list, i];
    const inner = list[i].children && findBlock(list[i].children, id);
    if (inner) return inner;
  }
  return null;
}

function saveBlockText(e, b, md, cx) {
  const body = b[b.type];
  const rich = b.type === "code" ? plainRich(md) : toRich(fromMd(md));
  if (!md.trim() && !b.children?.length) {
    const at = findBlock(e.blocks, b.id);
    if (at) at[0].splice(at[1], 1);
    return save(e, cx, () => notion(e.token, `blocks/${b.id}`, null, "DELETE"));
  }
  body.rich_text = rich.map((r) => ({ ...r, plain_text: r.text.content })); // shown until Notion answers
  save(e, cx, async () => {
    const next = await notion(e.token, `blocks/${b.id}`, { [b.type]: { rich_text: rich } }, "PATCH");
    Object.assign(b, next, { children: b.children });
  });
}

function addBlock(e, md, cx) {
  if (!md.trim()) return;
  const [prefix, type] = SHORTCUTS.find(([p]) => md.startsWith(p)) ?? ["", "paragraph"];
  const block = { object: "block", type, [type]: { rich_text: toRich(fromMd(md.slice(prefix.length))) } };
  const placeholder = { ...block, id: `new-${Date.now()}` };
  placeholder[type].rich_text = placeholder[type].rich_text.map((r) => ({ ...r, plain_text: r.text.content }));
  e.blocks.push(placeholder);
  save(e, cx, async () => {
    const json = await notion(e.token, `blocks/${e.page.id}/children`, { children: [block] }, "PATCH");
    e.blocks.splice(e.blocks.indexOf(placeholder), 1, ...json.results);
  });
}

const HEADING = { heading_1: 18, heading_2: 16, heading_3: 14.5 };

function blockView(ctx, e, b, number) {
  const { t } = ctx;
  const body = b[b.type] ?? {};
  let content;
  if (TEXT_BLOCKS.includes(b.type)) {
    const code = b.type === "code";
    const md = code ? plain(body.rich_text) : editableMd(body.rich_text);
    const text = md ?? plain(body.rich_text);
    const size = HEADING[b.type] ?? 13;
    const shown = code || md == null ? div().text_color(t.foreground).child(text)
      : !text ? div().h(20)
      : TextView.markdown(`md-${b.id}`, text).text_size(size).line_height(lineHeight(size));
    content = editableText(ctx, e, `block-${b.id}`, b.id.startsWith("new-") ? null : md, shown, true,
      (v, cx) => saveBlockText(e, b, v, cx), code ? { size: 12, mono: true, bg: t.raised } : { size, bold: Boolean(HEADING[b.type]) });
  } else if (b.type === "divider") {
    content = div().flex_1().h(1).my(8).bg(t.border);
  } else if (b.type === "table_row") {
    content = h_flex().flex_1().gap(8).children(body.cells.map((c) => div().flex_1().min_w(0).text_size(12.5).child(plain(c))));
  } else {
    const label = { child_page: body.title, child_database: body.title, bookmark: body.url, embed: body.url, link_preview: body.url,
      image: "Image", file: body.name ?? "File", pdf: "PDF", video: "Video", equation: body.expression }[b.type];
    content = muted(t, label || b.type.replace(/_/g, " ")).italic();
  }
  const marker = b.type === "bulleted_list_item" ? div().w(16).flex_none().pt(4).text_color(t.muted).child("•")
    : b.type === "numbered_list_item" ? div().w(20).flex_none().pt(4).text_color(t.muted).child(`${number}.`)
    : b.type === "to_do" ? div().id(`check-${b.id}`).pt(5).flex_none().cursor_pointer()
      .on_click((_e, cx) => {
        body.checked = !body.checked;
        save(e, cx, () => notion(e.token, `blocks/${b.id}`, { to_do: { checked: body.checked } }, "PATCH"));
      }).child(checkbox(t, body.checked))
    : b.type === "callout" && body.icon?.emoji ? div().flex_none().pt(4).child(body.icon.emoji)
    : null;
  return v_flex().gap(2)
    .child(h_flex().gap(6).items_start()
      .when(b.type === "quote", (el) => el.border_l(2).border_color(t.input).pl(8))
      .when(b.type === "callout", (el) => el.p(8).rounded(6).bg(t.raised))
      .when(Boolean(marker), (el) => el.child(marker))
      .when(b.type === "to_do" && body.checked, (el) => el.opacity(0.6))
      .child(content))
    .when(Boolean(b.children?.length), (el) => el.child(div().pl(20).child(blocksView(ctx, e, b.children))));
}

function blocksView(ctx, e, list) {
  let n = 0;
  return v_flex().gap(4).children(list.map((b) => {
    n = b.type === "numbered_list_item" ? n + 1 : 0;
    return blockView(ctx, e, b, n);
  }));
}

function page(ctx, e) {
  const { t } = ctx;
  return v_flex().gap(14).px(4).pb(20)
    .child(title(ctx, e))
    .when(Boolean(e.error), (el) => el.child(msg(t, e.error, t.blocked)))
    .child(properties(ctx, e))
    .child(div().h(1).bg(t.border))
    .child(blocksView(ctx, e, e.blocks))
    .child(editableText(ctx, e, "block-new", "", div().text_color(t.dim).child("Add text (# heading, - list, [] to-do)"), true,
      (v, cx) => addBlock(e, v, cx)))
    .child(comments(ctx, e))
    .when(e.saving > 0 || e.busy, (el) => el.child(spinning(t, e.saving ? "Saving…" : "Refreshing…")));
}

// ---- Comments ----

const commentTime = (s) => dateText({ start: isoLocal(s) });

// Opens the comment box (an event handler's job: its state can't be made in render).
function openComposer(ctx, e, cx) {
  if (editing) editing.state.blur();
  const state = TextareaState.new({ placeholder: "Add a comment…" });
  state.set_auto_grow(2, 12);
  // Clicking away closes an empty box; one with text stays open until it's posted.
  state.on("blur", (_e, cx) => {
    if (composer?.state !== state || state.value().trim()) return;
    closeComposer();
    cx.notify();
  });
  // Cmd+Enter posts and Esc cancels, as bindings in a key context around the box (the Textarea keeps Enter).
  if (!keysBound) keysBound = cx.bind_keys([
    { keystroke: "cmd-enter", action: "project_board_comment_post", context: "ProjectBoardComment > Input" },
    { keystroke: "ctrl-enter", action: "project_board_comment_post", context: "ProjectBoardComment > Input" },
    { keystroke: "escape", action: "project_board_comment_cancel", context: "ProjectBoardComment > Input" },
  ]) > 0;
  composer = { key: e.key, state };
  state.focus();
  ctx.scrollToEnd?.(); // the opened box is taller; bring all of it into view
  cx.notify();
}

let keysBound = false;

function closeComposer() {
  const state = composer?.state;
  composer = null;
  if (state) Promise.resolve().then(() => state.release());
}

// Posts the box's text as a reply to the latest thread, or a new comment, under the name of whoever connected
// Notion (display_name "user"; without it Notion shows the connection's name). The comment shows at once, with a
// spinner for an avatar until Notion has it; a failed one stays, marked, with Retry and Discard.
function postComment(e, cx) {
  const md = composer?.state.value().trim();
  if (!md) return;
  closeComposer();
  const rich = toRich(fromMd(md));
  const pending = { id: `pending-${Date.now()}`, pending: true, created_time: new Date().toISOString(), created_by: { id: e.me },
    rich_text: rich.map((r) => ({ ...r, plain_text: r.text.content })) };
  e.comments.push(pending);
  send(e, pending, rich, cx);
}

function send(e, pending, rich, cx) {
  pending.error = null;
  cx.notify();
  const last = e.comments.filter((c) => !c.pending).at(-1);
  cx.spawn(async (cx) => {
    try {
      const posted = await notion(e.token, "comments", {
        ...(last ? { discussion_id: last.discussion_id } : { parent: { page_id: e.page.id } }),
        rich_text: rich,
        display_name: { type: "user" },
      });
      e.comments.splice(e.comments.indexOf(pending), 1, posted);
    } catch (err) {
      pending.error = String(err?.message ?? err);
    }
    cx.notify();
  });
}

// The page's comments, oldest first, then the comment box.
function comments(ctx, e) {
  const { t } = ctx;
  if (e.comments.length) loadUsers(ctx.cx, e.token);
  const author = (c) => {
    const name = c.display_name?.resolved_name;
    return users?.find((u) => (name ? u.name === name : u.id === c.created_by?.id)) ?? { id: c.created_by?.id, name: name ?? "Someone" };
  };
  const link = (id, label, action) => div().id(id).cursor_pointer().text_color(t.foreground).hover((s) => s.opacity(0.8)).on_click(action).child(label);
  const comment = (c) => {
    const who = c.pending ? users?.find((u) => u.id === e.me) ?? { id: e.me, name: "You" } : author(c);
    const head = !c.pending ? person(ctx, who, 18)
      : h_flex().gap(6).items_center().flex_none()
        .child(c.error ? div().size(18).flex().items_center().justify_center().rounded_full().bg(t.blocked).text_size(11).text_color(t.background).child("!")
          : svg("mods/workspace-chrome/spinner.svg").size(18).text_color(t.muted).spin(900).loop("opacity", { from: 0.97, to: 1, period: 1000 }))
        .child(div().text_size(13).text_color(t.foreground).child(who.name));
    return v_flex().gap(2)
      .child(h_flex().gap(8).items_center().child(head)
        .child(div().text_size(12).text_color(t.dim).child(c.pending && !c.error ? "Posting…" : commentTime(c.created_time))))
      .child(div().pl(24).when(c.pending, (el) => el.opacity(0.6))
        .child(TextView.markdown(`comment-${c.id}`, editableMd(c.rich_text) ?? plain(c.rich_text)).text_size(13)))
      .when(Boolean(c.error), (el) => el.child(h_flex().pl(24).gap(10).text_size(12).text_color(t.blocked)
        .child(div().flex_1().min_w(0).child(`Couldn't post: ${c.error}`))
        .child(link(`retry-${c.id}`, "Retry", (_e, cx) => send(e, c, c.rich_text.map(({ plain_text, ...r }) => r), cx)))
        .child(link(`discard-${c.id}`, "Discard", (_e, cx) => { e.comments.splice(e.comments.indexOf(c), 1); cx.notify(); }))));
  };
  const c = composer?.key === e.key ? composer : null;
  const button = (id, primary, action) => h_flex().id(id).h(28).px(10).gap(6).items_center().rounded(6).text_size(12.5)
    .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
    .when(!primary, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)))
    .cursor_pointer().on_click(action);
  const box = c
    ? v_flex().gap(6).p(8).rounded(8).border_1().border_color(t.input).bg(t.background)
      .child(div().key_context("ProjectBoardComment")
        .on_action("project_board_comment_post", (_e, cx) => postComment(e, cx))
        .on_action("project_board_comment_cancel", (_e, cx) => { closeComposer(); cx.notify(); })
        .child(Textarea.new(c.state).w_full().text_size(13).line_height(lineHeight(13))))
      .child(h_flex().gap(6).items_center().justify_end()
        .child(button("comment-cancel", false, (_e, cx) => { closeComposer(); cx.notify(); }).child("Cancel"))
        .child(div().text_size(11.5).text_color(t.dim).child("⌘↩"))
        .child(button("comment-post", true, (_e, cx) => postComment(e, cx)).child("Comment")))
    : h_flex().id("comment-open").h(36).px(10).items_center().rounded(8).border_1().border_color(t.border).cursor_text()
      .text_size(13).text_color(t.dim).hover((s) => s.border_color(t.input))
      .on_click((_e, cx) => openComposer(ctx, e, cx)).child("Add a comment…");
  return v_flex().gap(12)
    .child(div().h(1).bg(t.border))
    .child(div().text_size(13).font_semibold().text_color(t.dim).child(e.comments.length ? `Comments (${e.comments.length})` : "Comments"))
    .when(Boolean(e.commentsError), (el) => el.child(msg(t, `Couldn't load comments: ${e.commentsError}`, t.blocked)))
    .children(e.comments.map(comment))
    .when(!e.commentsError, (el) => el.child(box));
}

// ---- Registration ----

const register = {
  title: (ctx) => found(ctx)?.key ?? null,
  // While the first answer is coming, a spinner where the card will be.
  header: (ctx) => (found(ctx) && (!load(ctx) || load(ctx).task) ? "Task" : null),
  summary: (ctx) => {
    const f = found(ctx);
    const e = load(ctx);
    return e?.task ? card(ctx, e) : f && !e ? spinning(ctx.t, `Loading ${f.key}…`) : null;
  },
  render: (ctx) => {
    const { t } = ctx;
    const f = found(ctx);
    if (!f) return msg(t, "No task: name the tab or branch after one (OI-42, say)");
    const e = load(ctx);
    if (!e) return spinning(t, `Loading ${f.key}…`);
    if (e.missing) return msg(t, `${f.key} isn't in any project board's databases`);
    if (!e.page) return msg(t, e.error ?? "Couldn't load the task", t.blocked);
    return page(ctx, e);
  },
};
(globalThis.contextPanel ??= {})[MOD] = register;

// Run under `herdr-app check`.
export function check() {
  const rich = (text, a = {}, link = null) => ({ type: "text", plain_text: text, text: { content: text, link: link && { url: link } }, annotations: { color: "default", ...a } });
  const md = editableMd([rich("a "), rich("b", { bold: true }), rich(" c", { italic: true }), rich("d", { code: true }), rich("e", {}, "https://x")]);
  if (md !== "a **b*** c*`d`[e](https://x)") throw new Error(`panel toMd is wrong: ${md}`);
  if (editableMd([rich("x", { color: "red" })]) !== null || editableMd([{ type: "mention", plain_text: "@x", annotations: {} }]) !== null) throw new Error("panel editableMd should refuse");
  if (editableMd([rich("2 * 3")]) !== "2 * 3") throw new Error("a lone * should edit as itself");
  if (JSON.stringify(fromMd("a * b").map((r) => r.text)) !== '["a * b"]') throw new Error("panel fromMd swallowed a lone *");
  if (toRich(fromMd("x".repeat(4500))).length !== 3) throw new Error("panel toRich doesn't split");
  if (dateText({ start: "2026-08-09T21:05:00.000+01:00" }) !== "Aug 9, 2026 9:05 PM" || dateText({ start: "2026-01-02" }) !== "Jan 2, 2026") throw new Error("panel dateText is wrong");
  if (parseTime("9:23 am") !== "09:23" || parseTime("12:00 AM") !== "00:00" || parseTime("21:05") !== "21:05" || parseTime("25:00") !== null) throw new Error("panel parseTime is wrong");
}

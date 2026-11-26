// github-pr: the agent's open pull request in the context panel (agents-sidebar-context-panel). Summary lines under
// a "Pull Request" header, each opening a dropdown, and a PR tab with the same rows: collapsible when the pane is
// narrow, a list and a detail pane when it's wide. A thread or review opens in a popup from a dropdown, in place in the tab.
// Copies: a dropdown thread's or review's popup (props.variant "popup"), and the panel's 1px loader window
// (props["context-panel"] = "load"), which only needs this module to run and register.
import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Popover, Popup, TextView } from "gpui-base";
import { checking, closeOverlay, hc, openOverlay, panes, props, setShared, shared, spaces, theme } from "herdr";
import { METHOD_KEY, agentPrs, attachingFor, closePr, avatarPath, listRepos, load, repoFor, merge, mergeMethod, openPrs, repoOf, setAutoMerge, setLink, snippet, summarize } from "./data.js";

const MOD = "github-pr";
const REOPEN = "agents-sidebar.github-pr-reopen"; // { agent, open, at }: a dropdown for the Summary to reopen
const WIDE = 560; // from this pane width, the PR tab is a list beside a detail pane
const I = (name) => `mods/${MOD}/icons/${name}.svg`;
const METHODS = { squash: "Squash and merge", merge: "Create a merge commit", rebase: "Rebase and merge" };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
// A line span as editors take it after a path: ":12" or ":12-20", or "" with no line.
const lineRange = (s, e) => (s && e && s !== e ? `:${s}-${e}` : e || s ? `:${e ?? s}` : "");
const stop = (el) => el.on_mouse_down("left", (_e, cx) => cx.stop_propagation());

// Colors: passed/approved, running/pending, failed/changes, not reporting.
const C = (t) => ({ green: t.ansi2, gold: t.ansi3, red: t.ansi1, grey: t.dim });

const icon = (name, color, size = 14) => svg(I(name)).size(size).flex_none().text_color(color);
// A running check: the gold dot inside a turning ring. spin() alone repaints at ~8 fps; the near-invisible
// opacity loop keeps the window repainting at ~30 fps, so the ring turns smoothly (as herdr-chat's spinner does).
const running = (t, size = 14) => div().relative().size(size).flex_none()
  .child(svg(I("dot")).absolute().inset_0().size(size).text_color(C(t).gold))
  .child(svg(I("spinner")).absolute().inset_0().size(size).text_color(C(t).gold).spin(900)
    .loop("opacity", { from: 0.97, to: 1, period: 1000 }));

// A person's picture (round), or a check's app logo (radius given); the first letter until it's downloaded.
function avatar(t, url, login, size = 18, radius = null) {
  const file = avatarPath(url);
  const round = (el) => (radius == null ? el.rounded_full() : el.rounded(radius));
  return file ? round(image(file).size(size).flex_none())
    : round(div().size(size).flex().flex_none().items_center().justify_center().bg(t.raised)
      .text_size(size * 0.55).text_color(t.muted).child((login ?? "?")[0].toUpperCase()));
}

// A ring split into arcs, one per [count, color], clockwise from the top; an empty one is a grey ring.
function ring(t, segs, size = 14) {
  const total = segs.reduce((n, [v]) => n + v, 0);
  const box = div().relative().size(size).flex_none();
  if (!total) return box.child(icon("ring", t.dim, size));
  // Lucide's radius (10 on a 24 grid), so it lines up with the circle icons in the other rows; a 2px stroke.
  const w = 2, r = size * 10 / 24, c = size / 2;
  const shown = segs.filter(([v]) => v);
  const gap = shown.length > 1 ? 0.3 : 0; // radians between arcs
  // Every arc gets at least `min` of visible ring, so 1 running check of 20 still shows; the rest is shared by count.
  const min = shown.length > 1 ? gap + 0.4 : 0, spare = 2 * Math.PI - min * shown.length;
  const at = (a, rr) => [c + rr * Math.sin(a), c - rr * Math.cos(a)];
  const ro = r + w / 2, ri = r - w / 2;
  // Points along an arc, every 0.05 rad or closer. Not arc_to: the renderer flattens a short arc to a near-straight
  // line at this size, and finds a long piece's centre from its ends, which drifts.
  const arc = (a, b, rr) => {
    const n = Math.max(2, Math.ceil(Math.abs(b - a) / 0.05));
    return Array.from({ length: n + 1 }, (_, i) => at(a + (b - a) * i / n, rr));
  };
  let a = 0;
  return box.children(shown.map(([v, color]) => {
    const span = min + (v / total) * spare, from = a + gap / 2, to = a + span - gap / 2;
    a += span;
    // A filled ring sector (outer arc, in along the radius, inner arc back), so each end points at the centre.
    const p = PathBuilder.fill().add_polygon([...arc(from, to, ro), ...arc(to, from, ri)], true);
    return div().absolute().inset_0().child(window.paint_path(p.build(), color));
  }));
}

// The status row's indicator, first that applies: conflicts, changes requested, failing checks, ready.
function indicator(t, pr, s) {
  const c = C(t);
  if (!s.open) return pr.state === "MERGED" ? icon("git-merge", t.ansi5) : icon("circle-x", c.grey);
  if (s.conflicting) return ring(t, [[1, c.red]]);
  if (s.changesRequested) return ring(t, [[s.reviews.approved, c.green], [s.reviews.changes, c.red], [s.reviews.pending, c.grey]]);
  if (s.failing) return ring(t, [[s.checks.passed, c.green], [s.checks.running, c.gold], [s.checks.failed, c.red], [s.checks.missing, c.grey]]);
  if (s.ready) return icon("circle-check", c.green);
  if (s.checks.running || s.checks.missing) return ring(t, [[s.checks.passed, c.green], [s.checks.running, c.gold], [s.checks.missing, c.grey]]);
  return ring(t, [[s.reviews.approved, c.green], [s.reviews.pending, c.grey]]);
}

function checksIcon(t, pr, s) {
  const c = C(t);
  if (s.checks.failedRequired) return icon("hexagon-alert", c.red);
  if (s.checks.failed) return icon("triangle-alert", c.red);
  if (s.checks.running) return running(t);
  if (s.checks.missing) return icon("hexagon-alert", c.grey);
  return icon("circle-check", pr.checks.length ? c.green : t.dim);
}

// The Reviews row's icon, the worst outcome first: changes requested (red file +/-), review required (grey),
// approved (green), pending (gold); grey when there's nothing to say.
const reviewsIcon = (t, pr, s) => {
  const c = C(t);
  return s.changesRequested ? icon("file-diff", c.red)
    : icon("badge-check", pr.decision === "REVIEW_REQUIRED" ? c.grey : s.reviews.approved ? c.green : s.reviews.pending ? c.gold : c.grey);
};

const reviewIcon = (t, state) => {
  const c = C(t);
  return state === "APPROVED" ? icon("check", c.green) : state === "CHANGES_REQUESTED" ? icon("file-diff", c.red)
    : state === "PENDING" ? icon("dot", c.gold) : state === "DISMISSED" ? icon("circle-x", c.grey) : icon("message", t.dim);
};
const checkIcon = (t, state) => {
  const c = C(t);
  return state === "passed" ? icon("circle-check", c.green) : state === "running" ? running(t)
    : state === "failed" ? icon("circle-x", c.red) : icon("hexagon-alert", c.grey);
};

// A GitHub button: opens url in the browser, without the click reaching the row under it.
const ghButton = (t, id, url) => stop(div().id(id).size(22).flex().flex_none().items_center().justify_center().rounded(5)
  .cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Open on GitHub")
  .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(url); })
  .child(svg(I("github")).size(14)));

// A menu/list row.
const entry = (t, id, onClick) => h_flex().id(id).min_h(28).px(6).gap(8).items_center().rounded(6)
  .when(Boolean(onClick), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)).on_click(onClick));
const note = (t, text) => div().px(6).py(4).text_size(12).text_color(t.dim).child(text);

// A thread or review is shown two ways. In the PR tab ("inline") it expands in place; in a dropdown ("menu") it
// opens in a popup (openPopup). v = { t, inline, state, agent? }.
function expander(v, key, headFn, bodyFn) {
  const { t, state } = v;
  const open = Boolean(state.exp?.[key]);
  return v_flex()
    .child(headFn(entry(t, `exp-${key}`, (_e, cx) => { (state.exp ??= {})[key] = !open; cx.notify(); }))
      .child(icon(open ? "chevron-down" : "chevron-right", t.dim, 12)))
    .when(open, (el) => el.child(div().pl(14).child(bodyFn())));
}

// "just now", "5m ago", "3h ago", "2d ago", then a date. Worked out at render, which the panel's refresh keeps current.
function ago(iso) {
  const s = (Date.now() - Date.parse(iso)) / 1000;
  if (!(s >= 60)) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 30 * 86400) return `${Math.floor(s / 86400)}d ago`;
  const d = new Date(iso);
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(d.getFullYear() !== new Date().getFullYear() && { year: "numeric" }) });
}

// When a comment was made, opening it on GitHub.
const agoLink = (t, id, c) => stop(div().id(id).flex_none().text_size(11.5).text_color(t.dim).cursor_pointer()
  .hover((s) => s.text_color(t.foreground)).tooltip("Open on GitHub")
  .on_click((_e, cx) => { cx.stop_propagation(); cx.open_url(c.url); })
  .child(c.at ? ago(c.at) : "on GitHub"));

const replies = (n) => `${n} ${n === 1 ? "reply" : "replies"}`;
const where = (th) => `${th.path}${lineRange(th.start, th.line)}`;

// A thread in full: its file and line, then each comment under its author.
function threadBody(t, th, id) {
  return v_flex().gap(10).p(6)
    .when(Boolean(th.path), (el) => el.child(h_flex().gap(6).items_center().text_size(11.5).text_color(t.dim)
      .child(icon("file", t.dim, 12)).child(div().flex_1().min_w(0).truncate().child(where(th)))
      .when(th.resolved, (el) => el.child(div().flex_none().child("Resolved")))))
    .children(th.comments.map((c, i) => v_flex().gap(4)
      .child(h_flex().gap(8).items_center()
        .child(avatar(t, c.avatar, c.login)).child(div().min_w(0).truncate().font_semibold().child(c.login))
        .child(agoLink(t, `at-${id}-${i}`, c)))
      .child(div().pl(26).child(TextView.markdown(`md-${id}-${i}`, c.body || "_No text_").text_size(12.5)))));
}

// In a dropdown, a thread or review opens in a popup: a dropdown can't scroll a long one (in a Popover, a scroll
// area never learns its content's height). The dropdown draws above overlays, so it closes; the popup's back row
// reopens it through REOPEN (see summary). `lines` guesses the popup's height.
function openPopup(v, what, title, lines, cx) {
  const back = { agent: v.agent, open: v.state.open, title };
  v.state.open = null;
  openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 380, height: Math.min(480, 40 + lines * 20),
    props: { variant: "popup", ...what, back } });
  cx.notify();
}
const textLines = (body) => 2 + Math.ceil(body.length / 48);
const threadLines = (th) => th.comments.reduce((n, c) => n + textLines(c.body), th.path ? 1 : 0);

// Comment threads, open ones first: who started each, what they said, where, and how many replies.
function commentList(v, threads, scope, back = "Comments") {
  const { t } = v;
  if (!threads.length) return note(t, "No comments");
  const firstResolved = threads.findIndex((th) => th.resolved);
  return v_flex().gap(2).children(threads.flatMap((th, i) => {
    const id = `${scope}-${th.id}`;
    const [first, ...rest] = th.comments;
    const meta = [first.login, th.path && `${th.path.split("/").pop()}${lineRange(th.start, th.line)}`, rest.length && replies(rest.length)];
    const head = (el) => el.py(4).items_start()
      .child(div().mt(1).flex_none().child(avatar(t, first.avatar, first.login)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(div().truncate().text_size(12.5).text_color(th.resolved ? t.dim : t.foreground).child(first.snippet))
        .child(div().truncate().text_size(11).text_color(t.dim).child(meta.filter(Boolean).join(" · "))));
    const row = v.inline ? expander(v, id, head, () => threadBody(t, th, id))
      : head(entry(t, `c-${id}`, (_e, cx) => openPopup(v, { thread: th }, back, threadLines(th), cx))).child(icon("chevron-right", t.dim, 12));
    return i === firstResolved ? [note(t, "Resolved"), row] : [row];
  }));
}

// The rows, each { key, icon, label, right, chevron, body?(v), click? }.
function items(t, pr, s, ctx) {
  const c = C(t);
  const num = (n, color) => div().text_color(color).child(String(n));
  const counted = (name, color, n) => n ? [h_flex().gap(3).items_center().child(icon(name, color, 13)).when(n > 1, (el) => el.child(num(n, t.muted)))] : [];
  const p = `pr${pr.number}`;
  return [
    { key: "title", icon: div().flex_none().text_color(t.dim).child(`#${pr.number}`), label: pr.title,
      right: [ghButton(t, `${p}-gh`, pr.url)],
      click: (_e, cx) => { ctx.show(MOD); cx.notify(); },
      body: () => v_flex().gap(6).p(6)
        .child(div().font_semibold().child(pr.title))
        .child(h_flex().gap(6).text_size(12).text_color(t.dim).child(`${pr.head} → ${pr.base}`).when(pr.draft, (el) => el.child(div().text_color(c.gold).child("Draft")))) },
    // Its repo, only when some PR shown isn't from the space's repo (then for every PR: see showRepo).
    ctx.showRepo && { key: "repo", icon: icon("book-marked", t.muted), label: `${pr.owner}/${pr.repo}`,
      right: [ghButton(t, `${p}-repo-gh`, `https://github.com/${pr.owner}/${pr.repo}`)],
      click: (_e, cx) => cx.open_url(`https://github.com/${pr.owner}/${pr.repo}`) },
    { key: "status", icon: indicator(t, pr, s), label: s.text, right: [], chevron: true,
      body: (v) => statusMenu(v, pr, s) },
    { key: "changes", icon: icon("file-diff", t.muted), label: "Changes",
      right: [h_flex().gap(3).items_center().child(icon("file", t.dim, 13)).child(num(pr.files, t.muted)),
        num(`+${pr.additions}`, pr.additions ? c.green : c.grey), num(`-${pr.deletions}`, pr.deletions ? c.red : c.grey)] },
    { key: "reviews", icon: reviewsIcon(t, pr, s), label: "Reviews", chevron: true,
      right: [...counted("file-diff", c.red, s.reviews.changes), ...counted("check", c.green, s.reviews.approved), ...counted("dot", c.gold, s.reviews.pending)],
      body: (v) => reviewsMenu(v, pr) },
    { key: "comments", icon: icon("message", t.muted), label: "Comments", chevron: true,
      right: [num(pr.threads.filter((th) => !th.resolved).length, t.muted), ...counted("check", t.dim, pr.threads.filter((th) => th.resolved).length)],
      body: (v) => commentList(v, pr.threads, `${p}-all`) },
    { key: "checks", icon: checksIcon(t, pr, s), label: "Checks", chevron: true,
      right: [[s.checks.passed, c.green], [s.checks.running, c.gold], [s.checks.failed, c.red], [s.checks.missing, c.grey]]
        .filter(([n]) => n).map(([n, color]) => num(n, color)),
      body: (v) => checksMenu(v, pr) },
    // "?" until the files are worked out locally. With none, a plain "No Conflicts" row (the Summary leaves it out).
    s.conflicting
      ? { key: "conflicts", icon: icon("git-conflict", c.red), label: "Conflicts", chevron: true,
          right: [num(pr.conflicts?.length ?? "?", c.red)], body: (v) => conflictsMenu(v, pr) }
      : { key: "conflicts", icon: icon("git-merge", t.muted), label: "No Conflicts" },
  ].filter(Boolean);
}

// Why GitHub won't merge it yet, each [icon, text], in the order they'd need fixing.
function blockers(t, pr, s) {
  const c = C(t);
  const n = (f) => pr.checks.filter((ch) => ch.required && f(ch)).length;
  const failed = n((ch) => ch.state === "failed"), pending = n((ch) => ch.state === "running"), missing = n((ch) => ch.state === "missing");
  const out = [];
  if (pr.draft) out.push([icon("file", t.dim, 12), "This pull request is still a draft"]);
  if (s.conflicting) out.push([icon("git-conflict", c.red, 12), `Conflicts with ${pr.base} must be resolved`]);
  if (s.changesRequested) out.push([icon("file-diff", c.red, 12), s.reviews.changes > 1 ? `${s.reviews.changes} reviewers requested changes` : "Changes were requested"]);
  else if (pr.decision === "REVIEW_REQUIRED") out.push([icon("badge-check", c.grey, 12), "An approving review is required"]);
  if (failed) out.push([icon("hexagon-alert", c.red, 12), `${plural(failed, "required check")} failing`]);
  if (pending) out.push([running(t, 12), `${plural(pending, "required check")} still running`]);
  if (missing) out.push([icon("hexagon-alert", c.grey, 12), `${plural(missing, "required check")} not reported`]);
  if (pr.mergeState === "BEHIND") out.push([icon("git-merge", c.gold, 12), `The branch is out of date with ${pr.base}`]);
  if (pr.mergeState === "UNKNOWN") out.push([icon("dot", c.grey, 12), "GitHub is still checking whether it can merge"]);
  if (!out.length) out.push([icon("hexagon-alert", c.grey, 12), `Blocked by ${pr.base}'s branch rules`]);
  return out;
}

// Modelled on GitHub's merge box: a haloed state icon, a heading and what it means, then a split merge button
// (the caret picks the method) and auto-merge.
// A hex color mixed toward black (amount 0..1); other colors as they are.
const darken = (color, amount) => {
  const m = /^#([0-9a-f]{6})/i.exec(color ?? "");
  if (!m) return color;
  const n = parseInt(m[1], 16), f = (x) => Math.round(x * (1 - amount)).toString(16).padStart(2, "0");
  return `#${f(n >> 16)}${f((n >> 8) & 255)}${f(n & 255)}`;
};

// The status content, modelled on GitHub's merge box: a badge (a pale ring round a solid circle with a white
// icon), the state and why, then the button GitHub would offer: Merge, Enable auto-merge, or Disable auto-merge.
// The arrow on Merge and Enable auto-merge opens a menu of merge methods over the content.
function statusMenu(v, pr, s) {
  const { t, state } = v;
  const c = C(t);
  const badge = (color, name) => div().relative().size(32).flex_none()
    .child(div().absolute().inset_0().rounded_full().bg(color).opacity(0.25))
    .child(div().absolute().inset(4).rounded_full().bg(darken(color, 0.45)).flex().items_center().justify_center()
      .child(icon(name, "#ffffff", 14)));
  const header = (mark, title, sub) => h_flex().gap(10).items_start().p(6)
    .child(mark)
    .child(v_flex().flex_1().min_w(0).gap(2)
      .child(div().h(32).flex().items_center().text_size(15).font_semibold().child(title)) // as tall as the badge: centred on it
      .child(sub));
  const line = (text) => div().text_size(12).text_color(t.muted).child(text);
  if (!s.open) return pr.state === "MERGED"
    ? header(badge(t.ansi5, "git-merge"), "Merged", line("This pull request was merged"))
    : header(badge(c.grey, "x"), "Closed", line("This pull request was closed"));

  const severe = s.conflicting || s.changesRequested || s.failing;
  const mark = s.ready ? badge(c.green, "check") : severe ? badge(c.red, "x") : badge(c.gold, "clock-hands");
  const sub = s.ready ? line("All requirements are met - merge the pull request.")
    : v_flex().gap(2).children(blockers(t, pr, s).map(([m, text]) =>
      h_flex().min_h(20).gap(6).items_center().text_size(12).text_color(t.muted).child(m).child(div().flex_1().min_w(0).child(text))));

  const method = mergeMethod(pr);
  const busy = state.autoBusy === pr.url;
  // Runs a GitHub action for this PR, showing it busy until it's done and any error under the button.
  const act = (run) => (_e, cx) => {
    state.autoBusy = pr.url;
    state.autoError = null;
    cx.spawn(async (cx) => {
      try { await run(); } catch (e) { state.autoError = String(e?.message ?? e); }
      state.autoBusy = null;
      cx.notify();
    });
    cx.notify();
  };
  // A GitHub button: green when it's the one to press, else grey with a border; dim and inert when disabled.
  const look = (el, green, enabled) => el.h(28).items_center()
    .when(green && enabled, (e) => e.bg(c.green).text_color(t.background))
    .when(!green || !enabled, (e) => e.bg(t.raised).border_1().border_color(t.border).text_color(enabled ? t.foreground : t.dim))
    .when(enabled, (e) => e.cursor_pointer().hover((st) => st.opacity(0.9)));
  // A split button's half: just the fill, since the border goes round the whole button.
  const fill = (el, green, enabled) => el.h_full().items_center()
    .bg(green && enabled ? c.green : t.raised).text_color(green && enabled ? t.background : enabled ? t.foreground : t.dim)
    .when(enabled, (e) => e.cursor_pointer().hover((st) => st.opacity(0.9)));
  // A button with an arrow that picks the merge method: one rounded outline (grey ones) with a 1px divider (the
  // theme's background on green, the border colour on grey).
  const split = (id, label, green, enabled, onClick) => {
    const key = `${id}-${pr.url}`;
    // A bare Popup the arrow toggles: a Popover here would be nested in the row's dropdown and fight it for clicks.
    const open = state.methodsFor === key;
    const arrow = Popup.new(`${id}-methods`, fill(h_flex().id(`${id}-arrow`).px(6).rounded_r(5), green, enabled)
        .border_l_1().border_color(green && enabled ? t.background : t.border).on_click((_e, cx) => {
          // A press on the arrow already closed an open menu (outside it): don't reopen it on the same click.
          if (!open && Date.now() - (state.methodsClosedAt ?? 0) < 400) return;
          state.methodsFor = open ? null : key;
          cx.notify();
        })
        .child(icon("chevron-down", green && enabled ? t.background : t.muted, 12)))
      .anchor("top_right").h_full() // the Popup is a box round the arrow: full height, so the arrow's fill is
      .when(open, (el) => el.content(div().pt(4).child(v_flex().id(`${id}-method-menu`).w(220).p(4).gap(1).rounded(8).bg(t.popover).border_1().border_color(t.border)
        .on_mouse_down_out((_e, cx) => { state.methodsFor = null; state.methodsClosedAt = Date.now(); cx.notify(); }) // a press elsewhere closes it
        .shadow_lg().text_size(13).text_color(t.foreground)
        .children(pr.methods.map((m) => entry(t, `${id}-method-${m}`, (_e, cx) => {
          state.methodsFor = null;
          if (shared(METHOD_KEY) !== m) setShared(METHOD_KEY, m);
          cx.notify();
        }).child(div().size(12).flex_none().child(m === method ? icon("check", t.foreground, 12) : div())).child(METHODS[m]))))));
    const hasArrow = pr.methods.length > 1 && enabled;
    return h_flex().h(28).rounded(6).overflow_hidden().font_semibold()
      .when(!(green && enabled), (el) => el.border_1().border_color(t.border))
      // Each half rounds its own outer corners: the outline's rounding doesn't clip their fill.
      .child(fill(h_flex().id(id).px(10), green, enabled).when(hasArrow, (el) => el.rounded_l(5)).when(!hasArrow, (el) => el.rounded(5))
        .when(enabled, (el) => el.on_click(onClick)).child(label))
      .when(hasArrow, (el) => el.child(arrow));
  };
  const plain = (id, label, onClick) => look(h_flex().id(id).px(10).rounded(6).font_semibold(), false, Boolean(onClick))
    .when(Boolean(onClick), (el) => el.on_click(onClick)).child(label);
  const auto = (on) => act(() => setAutoMerge(pr, on));
  const working = (text) => h_flex().gap(6).items_center().child(spinner(t)).child(text);
  const action = pr.autoMerge ? plain(`auto-off-${pr.number}`, busy ? working("Disabling…") : "Disable auto-merge", busy ? null : auto(false))
    : s.ready ? split(`merge-${pr.number}`, busy ? working("Merging…") : METHODS[method], true, !busy, act(() => merge(pr, method)))
    : pr.canAuto ? split(`auto-on-${pr.number}`, busy ? working("Enabling…") : `Enable auto-merge (${method})`, false, !busy, auto(true))
    : split(`merge-${pr.number}`, METHODS[method], true, false, null);
  return v_flex().gap(4)
    .child(header(mark, s.ready ? "Ready to merge" : "Merging is blocked", sub))
    .child(v_flex().pl(48).pr(6).pb(4).gap(4)
      .when(Boolean(pr.autoMerge), (el) => el.child(h_flex().gap(6).items_center().text_size(12).text_color(t.muted)
        .child(icon("clock-hands", c.green, 12))
        .child(div().flex_1().min_w(0).child(`Auto-merge enabled: ${METHODS[pr.autoMerge] ?? "merges"} once all requirements are met`))))
      .child(h_flex().child(action))
      .when(Boolean(state.autoError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(state.autoError))));
}

const VERDICT = { APPROVED: "Approved", CHANGES_REQUESTED: "Requested changes", COMMENTED: "Commented",
  DISMISSED: "Dismissed", PENDING: "Review requested" };
const verdictColor = (t, state) => ({ APPROVED: C(t).green, CHANGES_REQUESTED: C(t).red, PENDING: C(t).gold })[state] ?? t.dim;
const RANK = { CHANGES_REQUESTED: 0, PENDING: 1, COMMENTED: 2, DISMISSED: 3, APPROVED: 4 }; // what needs you first
const threadCount = (r) => {
  const open = r.threads.filter((th) => !th.resolved).length;
  return r.threads.length ? `${plural(r.threads.length, "thread")}${open && open < r.threads.length ? ` (${open} open)` : ""}` : null;
};

// A review in full: who and their verdict, what they wrote, then the threads they took part in.
// Expanded in place (`inline`), its row above already says who, the verdict and the threads.
function reviewBody(t, r, id, inline = false) {
  return v_flex().gap(8).p(6)
    .when(!inline, (el) => el.child(h_flex().gap(8).items_center()
      .child(avatar(t, r.avatar, r.login)).child(div().font_semibold().child(r.login))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(verdictColor(t, r.state)).child(VERDICT[r.state] ?? ""))
      .when(Boolean(r.url), (el) => el.child(ghButton(t, `gh-${id}`, r.url)))))
    .when(Boolean(r.body), (el) => el.child(div().when(!inline, (el) => el.pl(26)).child(TextView.markdown(`md-${id}`, r.body).text_size(12.5))))
    .when(!inline && r.threads.length > 0, (el) => el.child(div().pt(4).text_size(11.5).text_color(t.dim).child(threadCount(r))))
    .children(r.threads.map((th, i) => div().when(!inline || i > 0 || Boolean(r.body), (el) => el.border_t_1()).border_color(t.border).child(threadBody(t, th, `${id}-${th.id}`))));
}

// Reviewers, the ones that need you first: each one's verdict, the start of what they wrote, and their threads.
function reviewsMenu(v, pr) {
  const { t } = v;
  if (!pr.reviews.length) return note(t, "No reviews yet");
  return v_flex().gap(2).children([...pr.reviews].sort((a, b) => (RANK[a.state] ?? 5) - (RANK[b.state] ?? 5)).map((r) => {
    const id = `pr${pr.number}-rv-${r.login}`;
    const meta = [r.body && snippet(r.body), threadCount(r)].filter(Boolean).join(" · ");
    const head = (el) => el.py(4).items_start()
      .child(div().mt(1).flex_none().child(avatar(t, r.avatar, r.login)))
      .child(v_flex().flex_1().min_w(0).gap(1)
        .child(h_flex().gap(6).items_center().text_size(12.5)
          .child(div().flex_none().font_semibold().child(r.login))
          .child(div().min_w(0).truncate().text_size(12).text_color(verdictColor(t, r.state)).child(VERDICT[r.state] ?? "")))
        .when(Boolean(meta), (el) => el.child(div().truncate().text_size(11).text_color(t.dim).child(meta))))
      .child(div().mt(1).flex_none().child(reviewIcon(t, r.state)));
    if (!r.body && !r.threads.length) return head(entry(t, `rv-${id}`, null)).child(div().w(12)); // nothing more to show
    if (v.inline) return expander(v, id, head, () => reviewBody(t, r, id, true));
    const lines = 2 + (r.body ? textLines(r.body) : 0) + r.threads.reduce((n, th) => n + threadLines(th), 0);
    return head(entry(t, `rv-${id}`, (_e, cx) => openPopup(v, { review: r }, "Reviews", lines, cx))).child(icon("chevron-right", t.dim, 12));
  }));
}

function checksMenu(v, pr) {
  const { t } = v;
  if (!pr.checks.length) return note(t, "No checks");
  const order = { failed: 0, missing: 1, running: 2, passed: 3 };
  return v_flex().gap(1).children([...pr.checks].sort((a, b) => order[a.state] - order[b.state]).map((ch, i) =>
    entry(t, `pr${pr.number}-ck-${i}`, ch.url ? (_e, cx) => cx.open_url(ch.url) : null)
      .child(checkIcon(t, ch.state)).child(avatar(t, ch.avatar, ch.name, 16, 4))
      .child(h_flex().flex_1().min_w(0).gap(6).child(div().min_w(0).truncate().text_size(12.5).child(ch.name))
        .when(ch.required, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("Required"))))));
}

function conflictsMenu(v, pr) {
  const { t } = v;
  if (!pr.conflicts?.length) return note(t, `GitHub reports conflicts with ${pr.base}, but they couldn't be worked out from this checkout`);
  return v_flex().gap(1).children(pr.conflicts.map((f, i) => entry(t, `pr${pr.number}-cf-${i}`, null)
    .child(icon("file", t.dim, 13))
    .child(v_flex().flex_1().min_w(0).py(3).child(div().truncate().text_size(12.5).child(f.path))
      .when(f.lines.length > 0, (el) => el.child(div().truncate().text_size(11.5).text_color(t.dim)
        .child(`Lines ${f.lines.map(([a, b]) => lineRange(a, b).slice(1)).join(", ")}`))))));
}

// A row's head: icon, label, what's on the right, a chevron when it opens something.
const indented = (it) => it.key !== "title"; // rows sit 8px in, under the PR's number and title

function rowHead(t, id, it, { active, open, flush } = {}) {
  return h_flex().id(id).h(30).px(4).gap(8).items_center().flex_none().rounded(6)
    .when(indented(it) && !flush, (el) => el.ml(8))
    .when(Boolean(it.body || it.click), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
    .when(Boolean(active), (el) => el.bg(t.selected))
    .child(it.icon)
    .child(div().flex_1().min_w(0).truncate().child(it.label))
    // Without a chevron, inset to where the chevron's stroke ends, so right edges line up down the list.
    .child(h_flex().gap(6).flex_none().items_center().text_size(12).when(!it.chevron, (el) => el.mr(3)).children(it.right ?? []))
    .when(Boolean(it.chevron), (el) => el.child(icon(open ? "chevron-down" : "chevron-right", t.dim, 12)));
}

// The dropdown under a Summary row. The child mustn't shrink, or nothing overflows to scroll.
function menu(t, it, state, agent) {
  return v_flex().id(`menu-${it.key}`).w(300).max_h(420).p(4).rounded(8).bg(t.popover)
    .border_1().border_color(t.border).shadow_lg().text_size(13).text_color(t.foreground).overflow_y_scrollbar()
    .child(v_flex().flex_none().child(it.body({ t, inline: false, state, agent })));
}

function summaryRows(t, pr, ctx) {
  const s = summarize(pr);
  const { state } = ctx;
  return v_flex().children(items(t, pr, s, ctx).filter((it) => it.key !== "conflicts" || s.conflicting).map((it) => {
    const id = `ghpr-${pr.number}-${it.key}`;
    if (!it.body || it.click) return rowHead(t, id, it).when(Boolean(it.click), (el) => el.on_click(it.click));
    return menuRow(t, id, it, state, ctx.agent?.terminal ?? null);
  }));
}

// A row whose body opens as a dropdown under it.
// The indent goes outside the popover, so the dropdown's left edge lines up with the row, not the PR number.
const menuRow = (t, id, it, state, agent = null) => div().when(indented(it), (el) => el.pl(8))
  .child(Popover.new(`${id}-menu`).anchor("top_left").open(state.open === id)
    .on_open_change((open, cx) => {
      if (!open && state.methodsFor) return; // a method menu is open inside: it closes first
      state.open = open ? id : null;
      cx.notify();
    })
    .trigger(rowHead(t, id, it, { flush: true }))
    .content(div().pt(4).child(menu(t, it, state, agent)))); // 4px clear of the trigger's background

// The PR tab: narrow, each PR's rows expand in place (Status opens a dropdown, as in the Summary); wide, every PR's rows in one list beside a single pane with
// the selected row's content.
function tabView(t, prs, ctx, loading) {
  const { state } = ctx;
  const v = { t, inline: true, state };
  const key = (pr, it) => `pr${pr.number}-${it.key}`;
  // The title row is the tab's heading here: nothing to open but its GitHub button. Unlink goes under the PR's rows.
  const groups = prs.map((pr) => ({ pr, list: items(t, pr, summarize(pr), ctx).map((it) => (it.key === "title"
    ? { ...it, body: null, click: null } : it)) }));
  const unlink = (pr) => h_flex().mt(-4).justify_end().child(removeButton(t, pr, ctx)); // snug under the last 30px row
  if (ctx.width < WIDE) {
    return v_flex().gap(24).children(groups.map(({ pr, list }) => v_flex().gap(1).children(list.map((it) => {
      const k = key(pr, it), open = Boolean(state.exp?.[k]);
      if (it.key === "status") return menuRow(t, `tab-${k}`, it, state); // a dropdown, as in the Summary
      return v_flex()
        .child(rowHead(t, `tab-${k}`, { ...it, chevron: Boolean(it.body) }, { open })
          .when(Boolean(it.body), (el) => el.on_click((_e, cx) => { (state.exp ??= {})[k] = !open; cx.notify(); })))
        .when(open && Boolean(it.body), (el) => el.child(div().pl(22).pr(4).pb(6).child(it.body(v))));
    })).child(unlink(pr)))).children(loading);
  }
  const all = groups.flatMap(({ pr, list }) => list.map((it) => ({ pr, it })));
  const sel = all.find(({ pr, it }) => it.body && key(pr, it) === state.sel) ?? all.find(({ it }) => it.key === "status");
  const label = (it) => (it.key === "status" ? "Status" : typeof it.label === "string" ? it.label : "Pull request");
  return h_flex().items_stretch().gap(10) // both columns full height, content at the top
    .child(v_flex().w(260).flex_none().gap(24)
      .children(groups.map(({ pr, list }) => v_flex().gap(1).children(list.map((it) =>
        rowHead(t, `tab-${key(pr, it)}`, { ...it, chevron: Boolean(it.body) }, { active: it === sel?.it })
          .when(Boolean(it.body), (el) => el.on_click((_e, cx) => { state.sel = key(pr, it); cx.notify(); }))))
        .child(unlink(pr))))
      .children(loading))
    .child(v_flex().flex_1().min_w(0).pl(10).border_l_1().border_color(t.border).gap(4)
      .when(Boolean(sel), (el) => el
        .child(div().h(30).flex().items_center().px(6).text_size(12).font_semibold().text_color(t.dim)
          .child(prs.length > 1 ? `#${sel.pr.number} · ${label(sel.it)}` : label(sel.it)))
        .child(sel.it.body(v))));
}

// Unlinks the PR from this agent (it stays unlinked, even if it's the agent's branch's).
const removeButton = (t, pr, ctx) => smallButton(t, `rm-${pr.number}`, "unlink", "Unlink from agent", (_e, cx) => {
  cx.stop_propagation();
  const term = ctx.agent?.terminal;
  if (!term) return;
  const { state } = ctx;
  cx.spawn(async (cx) => {
    try { await setLink(term, pr.url, false); } catch (e) { state.linkError = String(e?.message ?? e); }
    cx.notify();
  });
});

// A small bordered button with an icon, for the actions row.
const smallButton = (t, id, iconName, label, onClick) => stop(h_flex().id(id).h(26).px(8).gap(6).flex_none().items_center()
  .rounded(6).border_1().border_color(t.border).text_size(12)
  .when(Boolean(onClick), (el) => el.cursor_pointer().text_color(t.foreground).hover((s) => s.bg(t.hover)).on_click(onClick))
  .when(!onClick, (el) => el.text_color(t.dim))
  .child(svg(I(iconName)).size(13).flex_none()).child(label));

// Asks the agent (types into its terminal) to open a PR; once per agent and branch.
function createButton(t, ctx) {
  const { state } = ctx;
  const asked = `${ctx.agent.terminal}\n${ctx.branch}`;
  if (state.askedFor === asked) return smallButton(t, "gh-create-pr", "check", "Asked the agent", null);
  return smallButton(t, "gh-create-pr", "git-pull-request", "Create New", (_e, cx) => {
    state.askedFor = asked;
    state.linkError = null;
    const text = ["main", "master", null].includes(ctx.branch ?? null)
      ? "Open a pull request for your work: create a branch for it, commit and push, then open it with gh pr create."
      : `Open a pull request for this branch (${ctx.branch}): commit and push any outstanding work, then open it with gh pr create.`;
    cx.spawn(async (cx) => {
      const r = await hc(["send", ctx.agent.terminal, text]).catch((e) => ({ code: 1, stderr: String(e?.message ?? e) }));
      if (r.code !== 0) { state.askedFor = null; state.linkError = r.stderr?.trim() || "Couldn't reach the agent"; }
      cx.notify();
    });
    cx.notify();
  });
}

// Create New and Attach Existing, side by side, under the PRs. Attach Existing opens a dialog to pick any repo's open PR.
function actions(t, ctx) {
  const { state } = ctx;
  state.shown = (load(ctx)?.prs ?? []).map((pr) => pr.url);
  return v_flex().gap(4).px(4).pt(20)
    .child(h_flex().gap(6).items_center()
      .when(!state.shown?.length && !attachingFor(ctx.agent?.terminal).length, (el) => el.child(createButton(t, ctx))) // only with no PR
      .child(smallButton(t, "gh-attach-open", "link", "Attach Existing", (_e, cx) => {
        try {
          const folders = spaceFolders(ctx);
          openOverlay({ mod: MOD, kind: "dialog", width: 480, height: 520,
            props: { variant: "attach", terminal: ctx.agent.terminal, folders, shown: state.shown ?? [] } });
        } catch (e) {
          state.linkError = `Couldn't open the dialog: ${e?.message ?? e}`;
        }
        cx.notify();
      })))
    .when(Boolean(state.linkError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(state.linkError)));
}

const spinner = (t) => svg(I("spinner")).size(14).flex_none().text_color(t.muted).spin(900)
  .loop("opacity", { from: 0.97, to: 1, period: 1000 }); // the loop keeps the spin smooth (see running)

// Before the agent's PRs first arrive.
const loadingAll = (t) => h_flex().id("ghpr-loading").h(30).px(4).gap(8).items_center().flex_none()
  .child(spinner(t)).child(div().flex_1().text_size(12.5).text_color(t.dim).child("Loading pull requests…"));

// A PR attached a moment ago, until its details arrive: its repo and number, a spinner and "Loading…".
function loadingRows(t, ctx, prs) {
  const have = new Set((prs ?? []).map((pr) => pr.url));
  return attachingFor(ctx.agent?.terminal).filter((url) => !have.has(url)).map((url, i) => {
    const [, repo, number] = url.match(/github\.com\/([^/]+\/[^/]+)\/pull\/(\d+)/) ?? [];
    return h_flex().id(`ghpr-loading-${i}`).h(30).px(4).gap(8).items_center().flex_none()
      .child(spinner(t))
      .child(h_flex().flex_1().min_w(0).gap(6).child(div().min_w(0).truncate().child(repo ?? url))
        .child(div().flex_none().text_color(t.dim).child(number ? `#${number}` : "")))
      .child(div().flex_none().text_size(12).text_color(t.dim).child("Loading…"));
  });
}

// How many PRs the agent shows (loading ones too), for the header and the tab's name.
const prCount = (ctx) => {
  const e = load(ctx);
  return (e?.prs?.length ?? 0) + loadingRows(ctx.t, ctx, e?.prs).length;
};

// Plural unless exactly one is attached (none attached lists the repo's PRs to pick from); singular while loading.
const prLabel = (ctx, n = prCount(ctx)) => (n === 1 || (!n && !load(ctx)) ? "Pull Request" : "Pull Requests");

// Where to look for the space's repo, in order: its first terminal's folder (as Herdr names spaces), the
// agent's, then the space's own folder (which can be home).
function spaceFolders(ctx) {
  const space = spaces().find((sp) => sp.tabs?.some((tb) => tb.id === ctx.agent?.tab));
  const tabs = space?.tabs?.map((tb) => tb.id) ?? [];
  const first = tabs.map((id) => panes().find((pn) => pn.tab === id && pn.terminal && pn.cwd)).find(Boolean);
  return [...new Set([first?.cwd, ctx.cwd, space?.folder].filter(Boolean))];
}

// Whether PRs show their repo: when any isn't from the space's repo (not while that's still being looked up).
function showRepo(ctx, prs) {
  if (!prs?.length) return false;
  const repo = repoFor(spaceFolders(ctx), ctx.cx);
  return repo !== undefined && prs.some((pr) => `${pr.owner}/${pr.repo}`.toLowerCase() !== repo?.toLowerCase());
}

const msgLine = (text, color) => div().px(4).py(6).text_size(12.5).text_color(color).child(text);
const none = (t, ctx) => msgLine(ctx.branch ? `No open pull request for ${ctx.branch}` : "No pull request", t.muted);

const register = {
  agentPrs, closePr, // the archive dialog's (agents-sidebar-agents/archive.js)
  title: (ctx) => prLabel(ctx),
  header: (ctx) => (prCount(ctx) || ctx.agent?.terminal || (ctx.cwd && !load(ctx)) ? prLabel(ctx) : null),
  summary: (ctx) => {
    const { t } = ctx;
    const back = shared(REOPEN); // a popup's back row: reopen its dropdown
    if (back && back.agent === (ctx.agent?.terminal ?? null) && back.at !== ctx.state.reopened
      && Date.now() - back.at < 5000) { // not an old one, in a panel opened since
      ctx.state.reopened = back.at; // once per hand-off
      ctx.state.open = back.open;
    }
    const e = load(ctx);
    if (!e) return ctx.cwd ? loadingAll(t) : null;
    const loading = loadingRows(t, ctx, e?.prs);
    if (!ctx.agent?.terminal && !e?.prs?.length) return null;
    ctx.showRepo = showRepo(ctx, e?.prs);
    return v_flex()
      .when(Boolean(e?.prs?.length), (el) => el.child(v_flex().gap(16).children(e.prs.map((pr) => summaryRows(t, pr, ctx)))))
      .children(loading)
      .when(Boolean(ctx.agent?.terminal) && !e?.prs?.length && !loading.length, (el) => el.child(none(t, ctx)).child(actions(t, ctx))); // the PR tab always has them
  },
  render: (ctx) => {
    const { t } = ctx;
    const e = load(ctx);
    const msg = (text, color = t.muted) => msgLine(text, color);
    if (!ctx.cwd) return msg("No folder");
    if (!e) return loadingAll(t);
    const loading = loadingRows(t, ctx, e.prs);
    ctx.showRepo = showRepo(ctx, e.prs);
    const body = e.error && !e.prs ? msg(e.error, t.blocked)
      : !e.prs?.length && !loading.length ? none(t, ctx)
      : tabView(t, e.prs ?? [], ctx, loading);
    // flex_none: the panel's scroll body is a flex column, which would squeeze a tall tab to fit instead of scrolling it.
    return v_flex().flex_none().gap(4).child(body).when(Boolean(ctx.agent?.terminal), (el) => el.child(actions(t, ctx)));
  },
};
(globalThis.contextPanel ??= {})[MOD] = register;

export default class GithubPr extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.variant = p.variant ?? null;
    if (this.variant === "attach") this.initAttach(p, cx);
  }

  render() {
    const t = theme();
    if (this.variant === "attach") return this.attachDialog(t);
    if (this.variant === "popup") return this.popup(t);
    return div();
  }

  // The attach dialog: a repo (the space's to start with), then its open PRs; picking one attaches it to the agent.
  initAttach(p, cx) {
    this.repos = null; // ["owner/name"], once listed
    this.repo = null;
    this.prs = null; // the repo's open PRs, once listed
    this.error = null;
    this.repoFilter = InputState.new({ placeholder: "Filter repositories" });
    this.repoFilter.on("change", (_e, cx) => cx.notify());
    this.prFilter = InputState.new({ placeholder: "Filter pull requests" });
    this.prFilter.on("change", (_e, cx) => cx.notify());
    if (checking()) return;
    cx.spawn(async (cx) => {
      let repo = null;
      for (const folder of p.folders ?? []) if (!repo) repo = await repoOf(folder);
      if (!this.repo) this.pickRepo(repo, cx);
      try { this.repos = await listRepos(); } catch (e) { this.repos = []; this.error ??= String(e?.message ?? e); }
      if (repo && !this.repos.includes(repo)) this.repos.unshift(repo);
      if (!this.repo && this.repos[0]) this.pickRepo(this.repos[0], cx);
      cx.notify();
    });
  }

  pickRepo(repo, cx) {
    if (!repo) return;
    this.repo = repo;
    this.prs = null;
    this.error = null;
    this.repoOpen = false;
    cx.spawn(async (cx) => {
      try {
        const prs = await openPrs(repo);
        if (this.repo === repo) this.prs = prs;
      } catch (e) {
        if (this.repo === repo) { this.prs = []; this.error = String(e?.message ?? e); }
      }
      cx.notify();
    });
    cx.notify();
  }

  attachDialog(t) {
    const p = props();
    const field = (state) => Input.new(state).h(28).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12.5);
    const rf = this.repoFilter.value().toLowerCase(), pf = this.prFilter.value().toLowerCase();
    const repos = (this.repos ?? []).filter((r) => r.toLowerCase().includes(rf));
    const prs = (this.prs ?? []).filter((pr) => `#${pr.number} ${pr.title} ${pr.author?.login} ${pr.headRefName}`.toLowerCase().includes(pf));
    const picker = Popover.new("attach-repo").anchor("top_left").open(Boolean(this.repoOpen))
      .on_open_change((open, cx) => { this.repoOpen = open; if (open) this.repoFilter.focus(); cx.notify(); })
      .trigger(h_flex().id("attach-repo-trigger").h(30).px(8).gap(8).items_center().rounded(6).border_1().border_color(t.input)
        .cursor_pointer().hover((s) => s.bg(t.hover))
        .child(icon("git-merge", t.muted)).child(div().flex_1().min_w(0).truncate().child(this.repo ?? "Choose a repository"))
        .child(icon("chevron-down", t.dim, 12)))
      .content(div().pt(4).child(v_flex().w(452).p(6).gap(4).rounded(8).bg(t.popover).border_1().border_color(t.border).shadow_lg()
        .text_size(13).text_color(t.foreground)
        .child(field(this.repoFilter))
        .child(v_flex().id("attach-repos").max_h(260).overflow_y_scrollbar()
          .when(!this.repos, (el) => el.child(note(t, "Loading repositories…")))
          .children(repos.map((r, i) => entry(t, `repo-${i}`, (_e, cx) => this.pickRepo(r, cx))
            .when(r === this.repo, (el) => el.bg(t.selected)).child(div().flex_1().min_w(0).truncate().child(r)))))));
    const list = !this.repo ? note(t, this.repos ? "Choose a repository" : "Loading…")
      : !this.prs ? note(t, "Loading pull requests…")
      : !prs.length ? note(t, this.prs.length ? "No pull requests match" : `No open pull requests in ${this.repo}`)
      : v_flex().gap(1).children(prs.map((pr) => {
        const shown = (p.shown ?? []).includes(pr.url);
        return entry(t, `pr-${pr.number}`, shown || this.busy ? null : (_e, cx) => {
          this.busy = true;
          cx.spawn(async (cx) => {
            try {
              await setLink(p.terminal, pr.url, true);
              closeOverlay(p.overlay);
            } catch (e) {
              this.error = String(e?.message ?? e);
            }
            this.busy = false;
            cx.notify();
          });
          cx.notify();
        })
          .child(icon("git-pull-request", pr.isDraft ? t.dim : C(t).green))
          .child(v_flex().flex_1().min_w(0).py(4)
            .child(h_flex().gap(6).child(div().flex_none().text_color(t.dim).child(`#${pr.number}`))
              .child(div().min_w(0).truncate().text_color(shown ? t.dim : t.foreground).child(pr.title)))
            .child(div().truncate().text_size(11.5).text_color(t.dim).child(`${pr.author?.login ?? "ghost"} · ${pr.headRefName}`)))
          .when(shown, (el) => el.child(div().flex_none().text_size(11.5).text_color(t.dim).child("Shown")));
      }));
    return v_flex().id("attach").size_full().bg(t.popover).text_color(t.foreground).text_size(13)
      .child(v_flex().px(18).pt(16).pb(10).gap(3).flex_none()
        .child(div().text_size(15).child("Attach a pull request"))
        .child(div().text_size(12).text_color(t.muted).child("It shows in this agent's panel, whatever its branch.")))
      .child(v_flex().px(14).gap(8).flex_none().child(picker).child(field(this.prFilter)))
      .child(div().id("attach-prs").flex_1().min_h(0).mx(10).mt(6).overflow_y_scrollbar().child(list))
      .when(Boolean(this.error), (el) => el.child(div().px(18).pt(6).text_size(12).text_color(t.blocked).child(this.error)))
      .child(h_flex().px(18).py(12).flex_none().justify_end().border_t_1().border_color(t.border)
        .child(div().id("attach-cancel").h(28).px(12).flex().items_center().rounded(7).text_size(12.8).cursor_pointer()
          .border_1().border_color(t.border).hover((s) => s.bg(t.hover)).on_click(() => closeOverlay(p.overlay)).child("Cancel")));
  }

  // A thread or review opened from a dropdown: a back row to it, then the thread or review.
  popup(t) {
    const p = props();
    return v_flex().id("popup").size_full().p(4).bg(t.popover).text_color(t.foreground).text_size(13).overflow_y_scrollbar()
      .child(entry(t, "comment-back", () => { setShared(REOPEN, { ...p.back, at: Date.now() }); closeOverlay(p.overlay); })
        .child(icon("chevron-left", t.dim, 12)).child(div().flex_1().truncate().text_color(t.muted).child(p.back.title ?? "Back")))
      .child(p.review ? reviewBody(t, p.review, "pop") : threadBody(t, p.thread, "pop"));
  }
}

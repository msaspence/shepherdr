// github-pr: the agent's open pull request in the context panel (agents-sidebar-context-panel). Summary lines under
// a "Pull Request" header, each opening a dropdown, and a PR tab with the same rows: collapsible when the pane is
// narrow, a list and a detail pane when it's wide (nested menus then become nested collapsibles).
// Copies: the merge dialog (props.variant "merge"), a review comment's popover (props.variant "comment"), and the
// panel's 1px loader window (props["context-panel"] = "load"), which only needs this module to run and register.
import { View, div, svg, image, PathBuilder } from "gpui-kit";
import { h_flex, v_flex, Input, InputState, Popover, TextView } from "gpui-base";
import { checking, closeOverlay, hc, openOverlay, props, spaces, theme } from "herdr";
import { avatarPath, listRepos, load, merge, mergeMethod, openPrs, repoOf, setAutoMerge, setLink, summarize } from "./data.js";

const MOD = "github-pr";
const WIDE = 560; // from this pane width, the PR tab is a list beside a detail pane
const I = (name) => `mods/${MOD}/icons/${name}.svg`;
const METHODS = { squash: "Squash and merge", merge: "Create a merge commit", rebase: "Rebase and merge" };
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const lineRange = (s, e) => (s && e && s !== e ? `L${s}–${e}` : e || s ? `L${e ?? s}` : "");
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
  const w = 2, r = (size - w) / 2, c = size / 2;
  const shown = segs.filter(([v]) => v);
  const gap = shown.length > 1 ? 0.5 : 0; // radians between arcs
  const at = (a) => [c + r * Math.sin(a), c - r * Math.cos(a)];
  let a = 0;
  return box.children(shown.map(([v, color]) => {
    const span = (v / total) * 2 * Math.PI, from = a + gap / 2, to = a + span - gap / 2;
    a += span;
    // In pieces of at most half a turn, so a full circle (one arc) still draws.
    let b = PathBuilder.stroke(w).move_to(...at(from));
    for (let x = from; x < to - 1e-6;) { x = Math.min(to, x + Math.PI * 0.999); b = b.arc_to(r, r, 0, false, true, ...at(x)); }
    return div().absolute().inset_0().child(window.paint_path(b.build(), color));
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

// Rows with nested content are shown two ways. In a dropdown ("menu"), a nested item replaces the list (with a
// back row) and a comment opens its own popover. In the PR tab ("inline"), both expand in place.
// v = { t, inline, state, pages } — pages collects the menu's nested pages while the list is described.
function nested(v, key, title, headFn, bodyFn) {
  const { t, state } = v;
  if (!v.inline) {
    v.pages[key] = { title, body: bodyFn };
    return headFn(entry(t, `nav-${key}`, (_e, cx) => { state.drill = key; cx.notify(); }))
      .child(icon("chevron-right", t.dim, 12));
  }
  const open = Boolean(state.exp?.[key]);
  return v_flex()
    .child(headFn(entry(t, `exp-${key}`, (_e, cx) => { (state.exp ??= {})[key] = !open; cx.notify(); }))
      .child(icon(open ? "chevron-down" : "chevron-right", t.dim, 12)))
    .when(open, (el) => el.child(div().pl(14).child(bodyFn())));
}

function commentBody(t, c, id) {
  return v_flex().gap(6).p(6)
    .child(h_flex().gap(8).items_center()
      .child(avatar(t, c.avatar, c.login)).child(div().flex_1().min_w(0).truncate().font_semibold().child(c.login))
      .child(ghButton(t, `gh-${id}`, c.url)))
    .when(Boolean(c.path), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(`${c.path} ${lineRange(c.start, c.line)}`)))
    .child(TextView.markdown(`md-${id}`, c.body || "_No text_").text_size(12.5));
}

// Review comments, grouped by author: each one's file and line, opening the comment.
function commentList(v, comments, scope) {
  const { t } = v;
  if (!comments.length) return note(t, "No comments");
  const groups = new Map();
  for (const c of comments) groups.set(c.login, [...(groups.get(c.login) ?? []), c]);
  return v_flex().gap(2).children([...groups].map(([login, list]) => v_flex()
    .child(h_flex().h(26).px(6).gap(8).items_center().child(avatar(t, list[0].avatar, login)).child(div().font_semibold().child(login)))
    .children(list.map((c) => {
      const id = `${scope}-${c.id}`;
      const head = (el) => el.pl(32).child(div().flex_1().min_w(0).truncate().text_size(12)
        .child(c.path
          ? h_flex().gap(6).child(div().min_w(0).truncate().child(c.path.split("/").pop()))
            .child(div().flex_none().text_color(t.dim).child(lineRange(c.start, c.line)))
          : div().truncate().text_color(t.muted).child(c.snippet)));
      if (v.inline) return nested(v, id, c.path ?? c.snippet, head, () => commentBody(t, c, id));
      return head(entry(t, `c-${id}`, (_e, cx) => {
        v.state.open = null; // the dropdown draws above overlays, so it makes way for the comment
        openOverlay({ mod: MOD, kind: "popup", at: "pointer", width: 380, height: Math.min(440, 120 + Math.ceil(c.body.length / 48) * 20),
          props: { variant: "comment", comment: c } });
        cx.notify();
      })).child(icon("chevron-right", t.dim, 12));
    }))));
}

// The rows, each { key, icon, label, right, chevron, body?(v), click? }.
function items(t, pr, s, ctx) {
  const c = C(t);
  const num = (n, color) => div().text_color(color).child(String(n));
  const counted = (name, color, n) => n ? [h_flex().gap(3).items_center().child(icon(name, color, 13)).when(n > 1, (el) => el.child(num(n, t.muted)))] : [];
  const p = `pr${pr.number}`;
  return [
    { key: "repo", icon: icon("git-merge", t.muted), label: h_flex().gap(6).min_w(0)
        .child(div().min_w(0).truncate().child(`${pr.owner}/${pr.repo}`)).child(div().flex_none().text_color(t.dim).child(`#${pr.number}`)),
      right: [ghButton(t, `${p}-gh`, pr.url)],
      click: (_e, cx) => { ctx.show(MOD); cx.notify(); },
      body: () => v_flex().gap(6).p(6)
        .child(div().font_semibold().child(pr.title))
        .child(h_flex().gap(6).text_size(12).text_color(t.dim).child(`${pr.head} → ${pr.base}`).when(pr.draft, (el) => el.child(div().text_color(c.gold).child("Draft")))) },
    { key: "status", icon: indicator(t, pr, s), label: s.text, right: [], chevron: true,
      body: (v) => statusMenu(v, pr, s) },
    { key: "changes", icon: icon("file-diff", t.muted), label: "Changes",
      right: [h_flex().gap(3).items_center().child(icon("file", t.dim, 13)).child(num(pr.files, t.muted)),
        num(`+${pr.additions}`, pr.additions ? c.green : c.grey), num(`-${pr.deletions}`, pr.deletions ? c.red : c.grey)] },
    { key: "reviews", icon: reviewsIcon(t, pr, s), label: "Reviews", chevron: true,
      right: [...counted("file-diff", c.red, s.reviews.changes), ...counted("check", c.green, s.reviews.approved), ...counted("dot", c.gold, s.reviews.pending)],
      body: (v) => reviewsMenu(v, pr) },
    { key: "comments", icon: icon("message", t.muted), label: "Comments", chevron: true,
      right: [num(pr.comments.length, t.muted)], body: (v) => commentList(v, pr.comments, `${p}-all`) },
    { key: "checks", icon: checksIcon(t, pr, s), label: "Checks", chevron: true,
      right: [[s.checks.passed, c.green], [s.checks.running, c.gold], [s.checks.failed, c.red], [s.checks.missing, c.grey]]
        .filter(([n]) => n).map(([n, color]) => num(n, color)),
      body: (v) => checksMenu(v, pr) },
    // "?" until the files are worked out locally. With none, a plain "No Conflicts" row (the Summary leaves it out).
    s.conflicting
      ? { key: "conflicts", icon: icon("git-conflict", c.red), label: "Conflicts", chevron: true,
          right: [num(pr.conflicts?.length ?? "?", c.red)], body: (v) => conflictsMenu(v, pr) }
      : { key: "conflicts", icon: icon("git-merge", t.muted), label: "No Conflicts" },
  ];
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

function statusMenu(v, pr, s) {
  const { t, state } = v;
  if (!s.open) return note(t, pr.state === "MERGED" ? "This pull request was merged" : "This pull request was closed");
  const box = (on) => div().size(14).flex().flex_none().items_center().justify_center().rounded(4).border_1()
    .border_color(on ? t.accent : t.input).when(on, (el) => el.bg(t.accent).text_color(t.accent_foreground).child(icon("check", t.accent_foreground, 11)));
  const busy = state.autoBusy === pr.url;
  return v_flex().gap(2)
    .child(entry(t, `merge-${pr.number}`, s.ready ? (_e, cx) => {
        state.open = null;
        openOverlay({ mod: MOD, kind: "dialog", width: 380, height: 300, props: { variant: "merge", pr } });
        cx.notify();
      } : null).when(!s.ready, (el) => el.text_color(t.dim))
      .child(icon("git-merge", s.ready ? C(t).green : t.dim)).child(div().flex_1().child(s.ready ? "Merge…" : "Merging is blocked")))
    .when(!s.ready, (el) => el.child(v_flex().pl(28).pr(6).pb(4).gap(2).children(blockers(t, pr, s).map(([mark, text]) =>
      h_flex().min_h(20).gap(6).items_center().text_size(12).text_color(t.muted).child(mark).child(div().flex_1().min_w(0).child(text))))))
    .child(entry(t, `auto-${pr.number}`, pr.canAuto && !busy ? (_e, cx) => {
        state.autoBusy = pr.url;
        state.autoError = null;
        cx.spawn(async (cx) => {
          try { await setAutoMerge(pr, !pr.autoMerge); } catch (e) { state.autoError = String(e?.message ?? e); }
          state.autoBusy = null;
          cx.notify();
        });
        cx.notify();
      } : null).when(!pr.canAuto || busy, (el) => el.text_color(t.dim))
      .child(box(pr.autoMerge)).child(div().flex_1().child(busy ? "Auto-merge…" : "Auto-merge")))
    .when(Boolean(state.autoError), (el) => el.child(note(t, state.autoError).text_color(t.blocked)));
}

function reviewsMenu(v, pr) {
  const { t } = v;
  if (!pr.reviews.length) return note(t, "No reviews yet");
  return v_flex().gap(4).children(pr.reviews.map((r) => {
    const id = `pr${pr.number}-rv-${r.login}`;
    const head = (el) => el.child(icon("message", t.dim)).child(div().flex_1().text_size(12).text_color(t.muted).child(plural(r.comments.length, "comment")));
    return v_flex().rounded(6).border_1().border_color(t.border)
      .child(h_flex().h(30).px(6).gap(8).items_center()
        .child(avatar(t, r.avatar, r.login)).child(div().flex_1().min_w(0).truncate().font_semibold().child(r.login))
        .child(reviewIcon(t, r.state))
        .child(r.url ? ghButton(t, `gh-${id}`, r.url) : div().size(22)))
      .child(r.comments.length
        ? nested(v, id, `${r.login}'s comments`, head, () => commentList(v, r.comments, id))
        : head(entry(t, `none-${id}`, null)));
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
        .child(f.lines.map(([a, b]) => lineRange(a, b)).join(", ")))))));
}

// A row's head: icon, label, what's on the right, a chevron when it opens something.
function rowHead(t, id, it, { active, open } = {}) {
  return h_flex().id(id).h(30).px(4).gap(8).items_center().flex_none().rounded(6)
    .when(Boolean(it.body || it.click), (el) => el.cursor_pointer().hover((s) => s.bg(t.hover)))
    .when(Boolean(active), (el) => el.bg(t.selected))
    .child(it.icon)
    .child(div().flex_1().min_w(0).truncate().child(it.label))
    // Without a chevron, inset to where the chevron's stroke ends, so right edges line up down the list.
    .child(h_flex().gap(6).flex_none().items_center().text_size(12).when(!it.chevron, (el) => el.mr(3)).children(it.right ?? []))
    .when(Boolean(it.chevron), (el) => el.child(icon(open ? "chevron-down" : "chevron-right", t.dim, 12)));
}

// The dropdown under a Summary row; a nested page shows in its place with a back row.
function menu(t, it, state) {
  const v = { t, inline: false, state, pages: {} };
  const list = it.body(v);
  const page = state.drill && v.pages[state.drill];
  return v_flex().id(`menu-${it.key}`).w(300).max_h(420).p(4).gap(2).rounded(8).bg(t.popover).border_1().border_color(t.border)
    .shadow_lg().text_size(13).text_color(t.foreground).overflow_y_scrollbar()
    .child(page
      ? v_flex().gap(2)
        .child(entry(t, "menu-back", (_e, cx) => { state.drill = null; cx.notify(); })
          .child(icon("chevron-left", t.dim, 12)).child(div().flex_1().truncate().text_color(t.muted).child(page.title)))
        .child(page.body())
      : list);
}

function summaryRows(t, pr, ctx) {
  const s = summarize(pr);
  const { state } = ctx;
  return v_flex().children(items(t, pr, s, ctx).filter((it) => it.key !== "conflicts" || s.conflicting).map((it) => {
    const id = `ghpr-${pr.number}-${it.key}`;
    if (!it.body || it.click) return rowHead(t, id, it).when(Boolean(it.click), (el) => el.on_click(it.click));
    return Popover.new(`${id}-menu`).anchor("top_left").open(state.open === id)
      .on_open_change((open, cx) => { state.open = open ? id : null; state.drill = null; cx.notify(); })
      .trigger(rowHead(t, id, it))
      .content(div().pt(4).child(menu(t, it, state))); // 4px clear of the trigger's background
  }));
}

// The PR tab: narrow, rows expand in place; wide, a list beside the selected row's content.
function tabRows(t, pr, ctx) {
  const s = summarize(pr);
  const { state } = ctx;
  const v = { t, inline: true, state, pages: {} };
  // The repo row is the tab's heading here: nothing to open; its GitHub button, and one to remove the PR from
  // this agent (it stays removed, even if it's the agent's branch's).
  const list = items(t, pr, s, ctx).map((it) => (it.key === "repo"
    ? { ...it, body: null, click: null, right: [...it.right, removeButton(t, pr, ctx)] } : it));
  const wide = ctx.width >= WIDE;
  const key = (it) => `pr${pr.number}-${it.key}`;
  if (!wide) {
    return v_flex().gap(1).children(list.map((it) => {
      const open = Boolean(state.exp?.[key(it)]);
      return v_flex()
        .child(rowHead(t, `tab-${key(it)}`, { ...it, chevron: Boolean(it.body) }, { open })
          .when(Boolean(it.body), (el) => el.on_click((_e, cx) => { (state.exp ??= {})[key(it)] = !open; cx.notify(); })))
        .when(open && Boolean(it.body), (el) => el.child(div().pl(22).pr(4).pb(6).child(it.body(v))));
    }));
  }
  const sel = list.find((it) => it.body && key(it) === state.sel) ?? list.find((it) => it.key === "status");
  return h_flex().items_start().gap(10)
    .child(v_flex().w(260).flex_none().gap(1).children(list.map((it) =>
      rowHead(t, `tab-${key(it)}`, { ...it, chevron: Boolean(it.body) }, { active: it === sel })
        .when(Boolean(it.body), (el) => el.on_click((_e, cx) => { state.sel = key(it); cx.notify(); })))))
    .child(v_flex().flex_1().min_w(0).pl(10).border_l_1().border_color(t.border).gap(4)
      .child(div().h(30).flex().items_center().px(6).text_size(12).font_semibold().text_color(t.dim).child(sel.key === "status" ? "Status" : typeof sel.label === "string" ? sel.label : "Pull request"))
      .child(sel.body(v)));
}

const removeButton = (t, pr, ctx) => stop(div().id(`rm-${pr.number}`).size(22).flex().flex_none().items_center().justify_center()
  .rounded(5).cursor_pointer().text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Remove from this agent")
  .on_click((_e, cx) => {
    cx.stop_propagation();
    const term = ctx.agent?.terminal;
    if (!term) return;
    const { state } = ctx;
    cx.spawn(async (cx) => {
      try { await setLink(term, pr.url, false); } catch (e) { state.linkError = String(e?.message ?? e); }
      cx.notify();
    });
  })
  .child(svg(I("x")).size(13)));

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
  return smallButton(t, "gh-create-pr", "git-pull-request", "Create PR", (_e, cx) => {
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

// Create PR and Attach PR, side by side, under the PRs. Attach opens a dialog to pick any repo's open PR.
function actions(t, ctx) {
  const { state } = ctx;
  state.shown = (load(ctx)?.prs ?? []).map((pr) => pr.url);
  return v_flex().gap(4).px(4).pt(6)
    .child(h_flex().gap(6).items_center()
      .child(createButton(t, ctx))
      .child(smallButton(t, "gh-attach-open", "git-merge", "Attach PR", (_e, cx) => {
        try {
          const space = spaces().find((sp) => sp.tabs?.some((tb) => tb.id === ctx.agent.tab));
          openOverlay({ mod: MOD, kind: "dialog", width: 480, height: 520,
            props: { variant: "attach", terminal: ctx.agent.terminal, folder: space?.folder || ctx.cwd, shown: state.shown ?? [] } });
        } catch (e) {
          state.linkError = `Couldn't open the dialog: ${e?.message ?? e}`;
        }
        cx.notify();
      })))
    .when(Boolean(state.linkError), (el) => el.child(div().text_size(12).text_color(t.blocked).child(state.linkError)));
}

const register = {
  header: (ctx) => {
    const n = load(ctx)?.prs?.length ?? 0;
    return n > 1 ? "Pull Requests" : n || ctx.agent?.terminal ? "Pull Request" : null;
  },
  summary: (ctx) => {
    const { t } = ctx;
    const e = load(ctx);
    if (!ctx.agent?.terminal && !e?.prs?.length) return null;
    return v_flex()
      .when(Boolean(e?.prs?.length), (el) => el.child(v_flex().gap(8).children(e.prs.map((pr) => summaryRows(t, pr, ctx)))))
      .when(Boolean(ctx.agent?.terminal) && !e?.prs?.length, (el) => el.child(actions(t, ctx))); // the PR tab always has them
  },
  render: (ctx) => {
    const { t } = ctx;
    const e = load(ctx);
    const msg = (text, color = t.muted) => div().px(4).py(6).text_size(12.5).text_color(color).child(text);
    if (!ctx.cwd) return msg("No folder");
    if (!e) return msg("Loading…");
    const body = e.error && !e.prs ? msg(e.error, t.blocked)
      : !e.prs?.length ? msg(ctx.branch ? `No open pull request for ${ctx.branch}` : "No pull request")
      : v_flex().gap(12).children(e.prs.map((pr) => tabRows(t, pr, ctx)));
    return v_flex().gap(4).child(body).when(Boolean(ctx.agent?.terminal), (el) => el.child(actions(t, ctx)));
  },
};
(globalThis.contextPanel ??= {})[MOD] = register;

export default class GithubPr extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.variant = p.variant ?? null;
    if (this.variant === "attach") this.initAttach(p, cx);
    if (this.variant === "merge") {
      this.method = mergeMethod(p.pr);
      this.deleteBranch = false;
    }
  }

  render() {
    const t = theme();
    if (this.variant === "merge") return this.mergeDialog(t);
    if (this.variant === "comment") return this.comment(t);
    if (this.variant === "attach") return this.attachDialog(t);
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
      const repo = await repoOf(p.folder);
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

  comment(t) {
    const c = props().comment;
    return v_flex().id("comment").size_full().bg(t.popover).text_color(t.foreground).text_size(13).overflow_y_scrollbar()
      .child(v_flex().gap(6).p(10)
        .child(h_flex().gap(8).items_center()
          .child(avatar(t, c.avatar, c.login, 20))
          .child(div().flex_1().min_w(0).truncate().font_semibold().child(c.login))
          .child(ghButton(t, "gh-comment", c.url)))
        .when(Boolean(c.path), (el) => el.child(div().text_size(11.5).text_color(t.dim).child(`${c.path} ${lineRange(c.start, c.line)}`)))
        .child(TextView.markdown("comment-body", c.body || "_No text_").text_size(12.5)));
  }

  mergeDialog(t) {
    const pr = props().pr;
    const radio = (on) => div().size(14).flex().flex_none().items_center().justify_center().rounded_full().border_1()
      .border_color(on ? t.accent : t.input).when(on, (el) => el.child(div().size(6).rounded_full().bg(t.accent)));
    const box = (on) => div().size(14).flex().flex_none().items_center().justify_center().rounded(4).border_1()
      .border_color(on ? t.accent : t.input).when(on, (el) => el.bg(t.accent).child(icon("check", t.accent_foreground, 11)));
    const option = (id, mark, label, onClick) => h_flex().id(id).h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover)).on_click(onClick).child(mark).child(label);
    const button = (id, label, primary, onClick) => div().id(id).h(28).px(12).flex().items_center().rounded(7).text_size(12.8)
      .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
      .when(!primary, (el) => el.border_1().border_color(t.border).hover((s) => s.bg(t.hover)))
      .when(Boolean(onClick), (el) => el.cursor_pointer().on_click(onClick)).when(!onClick, (el) => el.opacity(0.5))
      .child(label);
    return v_flex().id("merge").size_full().bg(t.popover).text_color(t.foreground).text_size(13)
      .child(v_flex().px(18).pt(16).pb(8).gap(3).flex_none()
        .child(div().text_size(15).child(`Merge #${pr.number}`))
        .child(div().text_size(12).text_color(t.muted).truncate().child(pr.title)))
      .child(v_flex().flex_1().min_h(0).px(10).gap(1)
        .children(pr.methods.map((m) => option(`m-${m}`, radio(this.method === m), METHODS[m], (_e, cx) => { this.method = m; cx.notify(); })))
        .child(div().h(1).mx(8).my(6).bg(t.border))
        .child(option("delete-branch", box(this.deleteBranch), `Delete ${pr.head} on GitHub`, (_e, cx) => { this.deleteBranch = !this.deleteBranch; cx.notify(); }))
        .when(Boolean(this.error), (el) => el.child(div().px(8).pt(6).text_size(12).text_color(t.blocked).child(this.error))))
      .child(h_flex().px(18).py(12).gap(8).flex_none().justify_end().border_t_1().border_color(t.border)
        .child(button("cancel", "Cancel", false, () => closeOverlay(props().overlay)))
        .child(button("do-merge", this.busy ? "Merging…" : METHODS[this.method], true, this.busy ? null : (_e, cx) => {
          this.busy = true;
          this.error = null;
          cx.spawn(async (cx) => {
            try {
              await merge(pr, this.method, this.deleteBranch);
              closeOverlay(props().overlay);
            } catch (e) {
              this.error = String(e?.message ?? e);
            }
            this.busy = false;
            cx.notify();
          });
          cx.notify();
        })));
  }
}

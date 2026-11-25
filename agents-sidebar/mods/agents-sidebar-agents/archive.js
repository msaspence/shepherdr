// Archiving an agent (its row's archive button): a dialog asks what to clean up, then the tab settles and the
// clean-up runs in this order, stopping at the first failure and saying so, so nothing unpushed goes:
//   commit what's left as "Clean up commit" (or, unticked, let the worktree's removal discard it), push the branch, close the agent's PRs, delete the branch on
//   origin, remove the worktree, delete the local branch.
// The PRs come from github-pr, which registers agentPrs/closePr on globalThis.contextPanel (mods can't import each other).

import { div, svg } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { checking, closeOverlay, exec, notify, openOverlay, panes, props, run, spaces } from "herdr";

const MOD = "agents-sidebar-agents";
const prMod = () => globalThis.contextPanel?.["github-pr"];

export const openArchive = (a) => openOverlay({ mod: MOD, kind: "dialog", width: 400, height: 410,
  props: { archive: { tab: a.tab, pane: a.pane, space: a.space, name: a.name ?? null } } });

function gitIn(on) {
  return async (dir, ...args) => {
    const r = await exec("git", args, { cwd: dir, on, timeout: 120_000 });
    if (r.code !== 0) throw new Error(`git ${args[0]}: ${(r.stderr || r.stdout).trim()}`);
    return r.stdout.trim();
  };
}

// What there is to clean up: null when the agent isn't in a git checkout.
async function inspect(arch) {
  const pane = panes().find((p) => p.pane === arch.pane);
  const cwd = pane?.cwd;
  if (!cwd) return null;
  const on = spaces().find((s) => s.id === arch.space)?.machine ?? null;
  const git = gitIn(on);
  let top, gitDir, common;
  try {
    top = await git(cwd, "rev-parse", "--show-toplevel");
    gitDir = await git(cwd, "rev-parse", "--path-format=absolute", "--git-dir");
    common = await git(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
  } catch { return null; }
  const branch = await git(top, "symbolic-ref", "--short", "HEAD").catch(() => null); // null: detached
  const base = (await git(top, "symbolic-ref", "--short", "refs/remotes/origin/HEAD").catch(() => "")).replace(/^origin\//, "");
  const inside = (p) => p.cwd === top || p.cwd?.startsWith(`${top}/`);
  return {
    on, cwd, top, terminal: pane.terminal, rawBranch: branch,
    main: common.replace(/\/\.git$/, ""),
    worktree: gitDir !== common,
    // The base branch is never offered: deleting main on origin is never a clean-up.
    branch: branch && branch !== base && !["main", "master"].includes(branch) ? branch : null,
    dirty: Boolean(await git(top, "status", "--porcelain").catch(() => "")),
    sharedWith: panes().some((p) => p.tab !== arch.tab && p.terminal && inside(p)),
  };
}

export function initArchive(view, cx) {
  view.opts = { local: true, commit: true, push: true, remote: false, prs: true, worktree: true };
  view.info = undefined; // undefined while looking, null when there's nothing to clean up
  view.prs = undefined;
  if (checking()) return;
  const arch = props().archive;
  cx.spawn(async (cx) => {
    view.info = await inspect(arch);
    cx.notify();
    const reg = prMod();
    if (!view.info || !reg?.agentPrs) { view.prs = []; view.prsNote = view.info && !reg ? "GitHub PR mod isn't loaded" : null; return cx.notify(); }
    try { view.prs = await reg.agentPrs(view.info.cwd, view.info.rawBranch, view.info.terminal); }
    catch (e) { view.prs = []; view.prsNote = String(e?.message ?? e); }
    cx.notify();
  });
}

// Which options apply here, and so whether each one counts.
function available(info, prs, o) {
  return {
    worktree: Boolean(info?.worktree && !info.sharedWith),
    // A branch can't be deleted while a checkout has it: only with its worktree going too.
    local: Boolean(info?.branch && info.worktree && !info.sharedWith && o.worktree),
    commit: Boolean(info?.dirty && info.branch && info.worktree && !info.sharedWith && o.worktree && o.local),
    push: Boolean(info?.branch && info.worktree && !info.sharedWith && o.worktree && o.local),
    remote: Boolean(info?.branch),
    prs: Boolean(prs?.length),
  };
}

async function cleanUp(info, prs, o) {
  const git = gitIn(info.on);
  const done = [];
  try {
    if (o.commit) {
      await git(info.top, "add", "-A");
      await git(info.top, "commit", "-m", "Clean up commit");
      done.push("committed what was left");
    }
    if (o.push) {
      await git(info.top, "push", "-u", "origin", info.branch);
      done.push(`pushed ${info.branch}`);
    }
    if (o.prs) {
      for (const pr of prs) await prMod().closePr(pr);
      done.push(`closed ${prs.map((pr) => `#${pr.number}`).join(", ")}`);
    }
    if (o.remote) {
      await git(info.top, "push", "origin", "--delete", info.branch);
      done.push(`deleted origin/${info.branch}`);
    }
    if (o.worktree) {
      // Refuses uncommitted changes, unless the branch is going and including them was unticked: then they're discarded.
      const discard = o.local && info.dirty && !o.commit;
      await git(info.main, "worktree", "remove", ...(discard ? ["--force"] : []), info.top);
      done.push(`removed ${info.top}`);
    }
    if (o.local) {
      // Pushed: -d, which refuses if somehow not on origin. Not pushed: deleting it anyway was asked for.
      await git(info.main, "branch", o.push ? "-d" : "-D", info.branch);
      done.push(`deleted ${info.branch}`);
    }
    if (done.length) notify({ title: "Cleaned up", body: cap(done.join("; ")), level: "success" });
  } catch (e) {
    notify({ title: "Clean-up stopped", body: `${done.length ? `${cap(done.join("; "))}, then ` : ""}${String(e?.message ?? e)}`, level: "error" });
  }
}
const cap = (s) => s[0].toUpperCase() + s.slice(1);

export function archiveDialog(view, t) {
  const arch = props().archive;
  const { info, prs, opts: o } = view;
  const can = available(info, prs, o);
  const box = (on) => div().size(14).flex().flex_none().items_center().justify_center().rounded(4).border_1()
    .border_color(on ? t.accent : t.input).when(on, (el) => el.bg(t.accent)
      .child(svg("mods/workspace-chrome/check.svg").size(11).text_color(t.accent_foreground)));
  // Options that don't apply here aren't shown.
  const option = (key, label, indent = false, toggle) => !can[key] ? null
    : h_flex().id(`opt-${key}`).h(30).px(8).gap(10).items_center().rounded(6).cursor_pointer().hover((s) => s.bg(t.hover))
      .when(indent, (el) => el.ml(24))
      .on_click((_e, cx) => {
        o[key] = !o[key];
        toggle?.(o[key]);
        cx.notify();
      })
      .child(box(o[key]))
      .child(div().flex_1().min_w(0).truncate().child(label));
  const button = (id, label, primary, onClick) => div().id(id).h(28).px(12).flex().items_center().rounded(7).text_size(12.8)
    .when(primary, (el) => el.bg(t.solid).text_color(t.solid_foreground))
    .when(!primary, (el) => el.border_1().border_color(t.border).hover((s) => s.bg(t.hover)))
    .cursor_pointer().on_click(onClick).child(label);
  const branch = info?.branch;
  const note = (text) => div().px(8).py(6).text_color(t.dim).child(text);
  const rows = info ? [
    option("local", `Remove local branch ${branch}`),
    option("commit", "Include unstaged changes", true),
    option("push", "Push to origin first", true, (on) => { if (on) o.remote = false; }),
    option("remote", `Remove origin/${branch}`, false, (on) => { if (on) o.push = false; }),
    option("prs", `Close attached PRs (${(prs ?? []).map((pr) => `#${pr.number}`).join(", ")})`),
    option("worktree", "Remove worktree"),
  ].filter(Boolean) : [];
  const body = info === undefined ? note("Looking at the checkout…")
    : v_flex().gap(1).children(rows)
      .when(prs === undefined, (el) => el.child(note("Looking for PRs…")))
      .when(!rows.length && prs !== undefined, (el) => el.child(note("Nothing to clean up.")));
  return v_flex().id("archive").size_full().bg(t.popover).text_color(t.foreground).text_size(13)
    .child(v_flex().px(18).pt(16).pb(8).gap(3).flex_none()
      .child(div().text_size(15).child("Archive agent"))
      .child(div().text_size(12).text_color(t.muted).truncate().child(info?.top ?? arch.name ?? "Clean up after it:")))
    .child(div().id("archive-options").flex_1().min_h(0).px(10).overflow_y_scrollbar().child(body))
    .child(h_flex().px(18).py(12).gap(8).flex_none().justify_end().border_t_1().border_color(t.border)
      .child(button("archive-cancel", "Cancel", false, () => closeOverlay(props().overlay)))
      .child(button("archive-go", "Archive", true, () => {
        // Snapshot what counts now: the dialog's view goes with it.
        const chosen = Object.fromEntries(Object.keys(can).map((k) => [k, can[k] && o[k]]));
        closeOverlay(props().overlay);
        run("tab.settle", { id: arch.tab });
        if (info && Object.values(chosen).some(Boolean)) cleanUp(info, prs ?? [], chosen);
      })));
}

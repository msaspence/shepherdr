// github-pr's data: an agent's PRs, from `gh` (one GraphQL query per PR), plus the merge conflicts worked out
// locally with `git merge-tree`, since GitHub only says whether there are any.
// An agent's PRs are its branch's open PRs, plus ones attached to it, minus ones removed from it. Attachments and
// removals are made in the PR tab and kept per agent terminal in .links.json:
//   { "<terminal>": { "add": [url], "drop": [url] } }
// A removed branch PR stays removed, even as the branch's PRs are fetched again.
// Module scope is shared by every copy of the mod (each panel, the merge dialog), so one cache serves them all.
import { appHome, checking, exec, home, readTextFile, setShared, shared, writeTextFile } from "herdr";

const POLL = 30000; // how often an agent's PRs are fetched again while a panel shows them
const LINKS = () => `${appHome()}/mods/github-pr/.links.json`;
const CACHE = "mods/github-pr/.cache"; // hidden, so downloads don't hot-reload the mod
export const METHOD_KEY = "agents-sidebar.github-pr-method"; // the last merge method picked

const QUERY = `query($owner:String!,$repo:String!,$number:Int!){
 repository(owner:$owner,name:$repo){
  mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed
  pullRequest(number:$number){
   number title url state isDraft mergeable mergeStateStatus reviewDecision additions deletions changedFiles
   baseRefName headRefName headRepository{ nameWithOwner }
   viewerCanEnableAutoMerge viewerCanDisableAutoMerge autoMergeRequest{ mergeMethod }
   baseRef{ branchProtectionRule{ requiredStatusCheckContexts } }
   reviewRequests(first:30){ nodes{ requestedReviewer{ __typename ... on User{ login avatarUrl } ... on Team{ name avatarUrl } } } }
   reviews(first:100){ nodes{ id url state author{ login avatarUrl } } }
   comments(first:100){ nodes{ id url body author{ login avatarUrl } } }
   reviewThreads(first:100){ nodes{ isResolved path line startLine originalLine originalStartLine
    comments(first:50){ nodes{ id url body author{ login avatarUrl } } } } }
   commits(last:1){ nodes{ commit{ statusCheckRollup{ contexts(first:100){ nodes{ __typename
    ... on CheckRun{ name status conclusion detailsUrl isRequired(pullRequestNumber:$number)
      checkSuite{ app{ name logoUrl } workflowRun{ workflow{ name } } } }
    ... on StatusContext{ context state targetUrl avatarUrl isRequired(pullRequestNumber:$number) } } } } } } }
  }
 }
}`;

// The files `git merge-tree` can't merge, each with its conflict blocks' line ranges ("path\t12-20,40-52").
// $1 the base branch, $2 the head: HEAD for the agent's own branch, else a branch fetched from origin.
const CONFLICTS_SH = `
git fetch -q origin "$1" 2>/dev/null
head=HEAD; if [ "$2" != HEAD ]; then git fetch -q origin "$2" 2>/dev/null; head="origin/$2"; fi
out=$(git merge-tree --write-tree --name-only --no-messages "$head" "origin/$1"); [ $? -eq 1 ] || exit 0
tree=$(printf '%s\\n' "$out" | head -1)
printf '%s\\n' "$out" | tail -n +2 | awk 'NF && !seen[$0]++' | while IFS= read -r f; do
  lines=$(git cat-file -p "$tree:$f" 2>/dev/null | awk '/^<<<<<<< /{s=NR} /^>>>>>>> /{if(s){printf "%s%d-%d", (n++?",":""), s, NR; s=0}}')
  printf '%s\\t%s\\n' "$f" "$lines"
done`;

const entries = new Map(); // "terminal\ncwd\nbranch" -> { at, busy, prs, error }
const avatars = new Set(); // cached avatar files, by name
let links = {}, linksText = null;

// Reads .links.json; true (and every answer stale) when it changed.
async function readLinks() {
  const text = (await readTextFile(LINKS()).catch(() => null)) ?? null;
  if (text === linksText) return false;
  linksText = text;
  try { links = JSON.parse(text ?? "{}") ?? {}; } catch { links = {}; }
  invalidate();
  return true;
}
const linksFor = (terminal) => ({ add: links[terminal]?.add ?? [], drop: links[terminal]?.drop ?? [] });

// Attaches a PR to an agent (on), or removes it (off, which also keeps its branch's PR from coming back).
export async function setLink(terminal, url, on) {
  await readLinks();
  const l = linksFor(terminal);
  const next = on ? { add: [...new Set([...l.add, url])], drop: l.drop.filter((u) => u !== url) }
    : { add: l.add.filter((u) => u !== url), drop: [...new Set([...l.drop, url])] };
  await writeTextFile(LINKS(), JSON.stringify({ ...links, [terminal]: next }, null, 2) + "\n", linksText);
  await readLinks();
}

async function gh(args, cwd) {
  const r = await exec("gh", args, { cwd: cwd ?? home(), timeout: 30000 });
  if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || `gh exited with ${r.code}`);
  return r.stdout;
}

// For the attach dialog: the repo a folder is a checkout of ("owner/name", or null), the repos this account can
// see (most recently pushed first; the first 100), and a repo's open PRs.
export async function repoOf(folder) {
  try { return (await gh(["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], folder)).trim() || null; } catch { return null; }
}
export async function listRepos() {
  return JSON.parse(await gh(["api", "user/repos?per_page=100&sort=pushed", "--jq", "[.[].full_name]"]));
}
export async function openPrs(repo) {
  return JSON.parse(await gh(["pr", "list", "-R", repo, "--state", "open", "--limit", "100", "--json", "number,title,url,author,headRefName,isDraft"]));
}

// The cached PRs for ctx's agent ({ prs, error, at } or null before the first answer), fetching again when stale.
// Called from render: the fetch runs on the panel's cx and redraws it when done.
export function load(ctx) {
  const { cwd, branch, cx } = ctx;
  const terminal = ctx.agent?.terminal ?? null;
  if (!cwd) return null;
  const key = `${terminal}\n${cwd}\n${branch}`;
  let e = entries.get(key);
  if (!e) entries.set(key, (e = { at: 0, busy: false, prs: null, error: null }));
  if (!e.busy && !checking() && Date.now() - e.at > POLL) {
    e.busy = true;
    cx.spawn(async (cx) => {
      try {
        e.prs = await fetchPrs(cwd, branch, terminal);
        e.error = null;
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

// Every cached answer is fetched again on its panel's next render (after a merge, say).
export function invalidate() {
  for (const e of entries.values()) e.at = 1;
}

async function fetchPrs(cwd, branch, terminal) {
  if (linksText === null) await readLinks();
  const l = linksFor(terminal);
  let mine = [];
  try {
    if (branch) mine = JSON.parse(await gh(["pr", "list", "--head", branch, "--state", "open", "--json", "url"], cwd)).map((p) => p.url);
  } catch (e) {
    if (!l.add.length) throw e; // not a GitHub repo, say; attached PRs can still show
  }
  const urls = [...new Set([...mine.filter((u) => !l.drop.includes(u)), ...l.add])];
  const prs = [];
  for (const url of urls) {
    const [, owner, repo, number] = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/) ?? [];
    if (!owner) continue;
    // A field this account can't read (branch protection, say) comes back null with an error beside the data.
    const r = await exec("gh", ["api", "graphql", "-f", `query=${QUERY}`, "-f", `owner=${owner}`, "-f", `repo=${repo}`, "-F", `number=${number}`], { cwd: home(), timeout: 30000 });
    let data;
    try { data = JSON.parse(r.stdout).data; } catch {}
    if (!data?.repository?.pullRequest) throw new Error(r.stderr.trim().split("\n").pop() || `Couldn't load #${number}`);
    const pr = normalize(owner, repo, data.repository);
    pr.auto = mine.includes(url); // from the agent's branch, not attached
    if (pr.mergeable === "CONFLICTING") pr.conflicts = await conflicts(cwd, pr.base, pr.head === branch ? "HEAD" : pr.head);
    prs.push(pr);
  }
  await Promise.all(prs.flatMap((pr) => [...pr.reviews, ...pr.comments, ...pr.checks]).map((x) => cacheAvatar(x.avatar)));
  return prs;
}

const PASS = new Set(["SUCCESS", "NEUTRAL", "SKIPPED"]);
const OPINION = new Set(["APPROVED", "CHANGES_REQUESTED", "DISMISSED"]);

// The start of a comment's text as one plain line: no HTML, markdown marks or line breaks.
export const snippet = (body) => (body ?? "").replace(/<!--[\s\S]*?-->/g, " ").replace(/<[^>]+>/g, " ")
  .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/[#>*_`~|]/g, "").replace(/\s+/g, " ").trim().slice(0, 120) || "No text";

export function normalize(owner, repo, r) {
  const p = r.pullRequest;
  const who = (a) => ({ login: a?.login ?? "ghost", avatar: a?.avatarUrl ?? null });
  const comments = p.reviewThreads.nodes.flatMap((th) => th.comments.nodes.map((c) => ({
    id: c.id, url: c.url, body: c.body ?? "", path: th.path, resolved: th.isResolved,
    line: th.line ?? th.originalLine, start: th.startLine ?? th.originalStartLine, ...who(c.author) })));
  // Conversation comments have no file: they're labelled with the start of their text instead.
  const general = p.comments.nodes.map((c) => ({ id: c.id, url: c.url, body: c.body ?? "", path: null, snippet: snippet(c.body), ...who(c.author) }));

  // Each reviewer's standing review: their latest approval, change request or dismissal, else their latest comment.
  // Requested reviewers (again, or for the first time) are pending.
  const byAuthor = new Map();
  for (const rv of p.reviews.nodes) {
    if (rv.state === "PENDING") continue;
    const { login, avatar } = who(rv.author);
    const prev = byAuthor.get(login);
    if (!prev || OPINION.has(rv.state) || !OPINION.has(prev.state)) byAuthor.set(login, { login, avatar, state: rv.state, url: rv.url });
  }
  for (const { requestedReviewer: q } of p.reviewRequests.nodes) {
    if (!q) continue;
    const login = q.login ?? q.name;
    byAuthor.set(login, { ...byAuthor.get(login), login, avatar: q.avatarUrl, state: "PENDING" });
  }
  const reviews = [...byAuthor.values()].map((rv) => ({ ...rv, comments: comments.filter((c) => c.login === rv.login) }));

  const nodes = p.commits.nodes[0]?.commit?.statusCheckRollup?.contexts?.nodes ?? [];
  const checks = nodes.map((n) => n.__typename === "CheckRun"
    ? { key: n.name, name: n.checkSuite?.workflowRun?.workflow?.name ? `${n.checkSuite.workflowRun.workflow.name} / ${n.name}` : n.name,
        state: n.status !== "COMPLETED" ? "running" : PASS.has(n.conclusion) ? "passed" : "failed",
        required: Boolean(n.isRequired), url: n.detailsUrl, avatar: n.checkSuite?.app?.logoUrl ?? null }
    : { key: n.context, name: n.context,
        state: n.state === "SUCCESS" ? "passed" : n.state === "PENDING" || n.state === "EXPECTED" ? "running" : "failed",
        required: Boolean(n.isRequired), url: n.targetUrl, avatar: n.avatarUrl ?? null });
  const present = new Set(checks.map((c) => c.key));
  for (const key of p.baseRef?.branchProtectionRule?.requiredStatusCheckContexts ?? []) {
    if (!present.has(key)) checks.push({ key, name: key, state: "missing", required: true, url: null, avatar: null });
  }

  return {
    owner, repo, number: p.number, title: p.title, url: p.url, draft: p.isDraft, state: p.state,
    mergeable: p.mergeable, mergeState: p.mergeStateStatus, decision: p.reviewDecision,
    additions: p.additions, deletions: p.deletions, files: p.changedFiles,
    base: p.baseRefName, head: p.headRefName, headRepo: p.headRepository?.nameWithOwner ?? null,
    methods: [r.squashMergeAllowed && "squash", r.mergeCommitAllowed && "merge", r.rebaseMergeAllowed && "rebase"].filter(Boolean),
    autoMerge: Boolean(p.autoMergeRequest), canAuto: p.viewerCanEnableAutoMerge || p.viewerCanDisableAutoMerge,
    reviews, comments: [...general, ...comments], checks, conflicts: null,
  };
}

async function conflicts(cwd, base, head) {
  try {
    const r = await exec("sh", ["-c", CONFLICTS_SH, "_", base, head], { cwd, timeout: 30000 });
    if (r.code !== 0) return null;
    return r.stdout.split("\n").filter(Boolean).map((l) => {
      const [path, ranges = ""] = l.split("\t");
      return { path, lines: ranges ? ranges.split(",").map((x) => x.split("-").map(Number)) : [] };
    });
  } catch {
    return null;
  }
}

// Counts the rows show, and the PR's overall state.
export function summarize(pr) {
  const n = (list, f) => list.filter(f).length;
  const checks = {
    passed: n(pr.checks, (c) => c.state === "passed"), running: n(pr.checks, (c) => c.state === "running"),
    failed: n(pr.checks, (c) => c.state === "failed"), missing: n(pr.checks, (c) => c.state === "missing"),
    failedRequired: n(pr.checks, (c) => c.state === "failed" && c.required),
  };
  const reviews = {
    approved: n(pr.reviews, (r) => r.state === "APPROVED"), changes: n(pr.reviews, (r) => r.state === "CHANGES_REQUESTED"),
    pending: n(pr.reviews, (r) => r.state === "PENDING"),
  };
  const conflicting = pr.mergeable === "CONFLICTING";
  const changesRequested = pr.decision === "CHANGES_REQUESTED" || reviews.changes > 0;
  const failing = checks.failed > 0;
  const open = pr.state === "OPEN";
  const ready = open && !pr.draft && !conflicting && ["CLEAN", "HAS_HOOKS", "UNSTABLE"].includes(pr.mergeState);
  const problems = [conflicting && "Merge conflicts", changesRequested && "Changes requested", failing && "Failing checks"].filter(Boolean);
  const text = !open ? (pr.state === "MERGED" ? "Merged" : "Closed") : ready ? "Ready to merge" : problems.length > 1 ? "Multiple problems" : problems[0]
    ?? (pr.draft ? "Draft" : checks.running ? "Checks running" : pr.mergeState === "BEHIND" ? "Out of date"
      : pr.decision === "REVIEW_REQUIRED" ? "Review required" : pr.mergeState === "UNKNOWN" ? "Checking mergeability" : "Blocked");
  return { checks, reviews, conflicting, changesRequested, failing, ready, open, text };
}

// Avatars and check app logos, downloaded once; avatarPath is null until the file exists.
const avatarName = (url) => `avatars/${url.replace(/^https?:\/\//, "").replace(/[^A-Za-z0-9]+/g, "_")}.png`;
const sized = (url) => (url.includes("avatars.githubusercontent.com") ? `${url}${url.includes("?") ? "&" : "?"}s=48` : url);
async function cacheAvatar(url) {
  if (!url || avatars.has(avatarName(url))) return;
  const file = `${appHome()}/${CACHE}/${avatarName(url)}`;
  const r = await exec("sh", ["-c", 'test -s "$1" || curl -sfL --create-dirs -o "$1" "$2"', "_", file, sized(url)]).catch(() => null);
  if (r?.code === 0) avatars.add(avatarName(url));
}
export const avatarPath = (url) => (url && avatars.has(avatarName(url)) ? `${CACHE}/${avatarName(url)}` : null);

export const mergeMethod = (pr) => (pr.methods.includes(shared(METHOD_KEY)) ? shared(METHOD_KEY) : pr.methods[0] ?? "merge");

// Merges, then deletes the head branch on GitHub if asked (not the local one: an agent may be working in it).
export async function merge(pr, method, deleteBranch) {
  if (shared(METHOD_KEY) !== method) setShared(METHOD_KEY, method);
  await gh(["pr", "merge", pr.url, `--${method}`]);
  if (deleteBranch && pr.headRepo) await gh(["api", "-X", "DELETE", `repos/${pr.headRepo}/git/refs/heads/${pr.head}`]);
  invalidate();
}

export async function setAutoMerge(pr, on) {
  await gh(["pr", "merge", pr.url, ...(on ? ["--auto", `--${mergeMethod(pr)}`] : ["--disable-auto"])]);
  invalidate();
}

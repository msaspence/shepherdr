// The Notion provider: Tech Tasks-shaped databases. Needed: Assignee (people) and Status (status); used if
// there: the title, ID (unique id), In Flight (status), Priority (select), Blocked by (relation). A space's config, which the setup dialog writes:
//   { "provider": "notion", "tokenFile": "<path>", "assignee": "<Notion user id>", "projects": ["<data source id>", …] }
// tokenFile defaults to ~/.config/notion-board/token (where notion-login.py saves when run by hand).
// The provider contract, and the task shape every provider returns, are documented in providers/index.js.
import { appHome, exec, home, readTextFile } from "herdr";

const STATUSES = ["In progress", "Queued", "Done"]; // Released tasks leave the board
const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
export const ICON_COLORS = { red: "ansi1", green: "ansi2", yellow: "ansi3", blue: "ansi4", purple: "ansi5", pink: "ansi13", orange: "ansi11", brown: "ansi3" };
const TOKEN = ".config/notion-board/token"; // under home
const API = "https://api.notion.com/v1";

// POSTs body, else GETs; method overrides (PATCH, DELETE).
export async function notion(token, path, body, method = body ? "POST" : "GET") {
  const res = await fetch(`${API}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(json.message ?? `Notion ${res.status}`);
  return json;
}

export const readToken = async (config) => {
  const token = (await readTextFile(config.tokenFile ?? `${home()}/${TOKEN}`))?.trim();
  if (!token) throw new Error("not connected (no token)");
  return token;
};

// What a database needs for its tasks to be queried; null when it has it.
const missing = (properties = {}) => {
  const need = Object.entries({ Assignee: "people", Status: "status" }).filter(([k, type]) => properties[k]?.type !== type);
  return need.length ? `Not a task database: no ${need.map(([k, type]) => `${k} (${type})`).join(" or ")} property` : null;
};

export const keyOf = (p) => {
  const id = p.properties.ID?.unique_id;
  return id ? `${id.prefix}-${id.number}` : p.id.slice(0, 6);
};

// The In Flight status's stage: Not started is queued, Done is done, everything between in progress.
const stage = (name) => (name === "Done" ? "done" : name === "Not started" ? "queued" : "progress");

export function toTask(p) {
  const id = p.properties.ID?.unique_id;
  const inFlight = p.properties["In Flight"]?.status;
  const icon = p.icon?.type === "emoji" ? { emoji: p.icon.emoji }
    : p.icon?.type === "icon" ? { svg: `https://cdn.jsdelivr.net/npm/lucide-static/icons/${p.icon.icon.name}.svg`, color: ICON_COLORS[p.icon.icon.color] }
    : null;
  return {
    id: p.id,
    key: keyOf(p),
    title: Object.values(p.properties).find((x) => x.type === "title")?.title.map((t) => t.plain_text).join("") ?? "",
    icon,
    status: inFlight ? { name: inFlight.name, stage: stage(inFlight.name) } : null,
    rank: [PRIORITY_RANK[p.properties.Priority?.select?.name] ?? 3, id?.number ?? Infinity],
    people: p.properties.Assignee.people.map((u) => ({ id: u.id, name: u.name, avatar: u.avatar_url })),
    blockedBy: p.properties["Blocked by"]?.relation?.map((r) => r.id) ?? [],
    url: p.url,
  };
}

export default {
  name: "Notion",
  icon: "mods/project-board/notion.svg",
  description: "Your tasks from a Notion database",
  setupHint: "Check the connection, or set the board up again",

  // OAuth in the browser (notion-login.py), saving this space's token. Resolves to the config so far.
  async connect({ space }) {
    const tokenFile = `${appHome()}/data/project-board/tokens/${space}-notion`;
    const script = `${appHome()}/mods/project-board/notion-login.py`;
    // A login shell finds python3 wherever it's installed; an abandoned login still holding the port is stopped first.
    const r = await exec("/bin/sh", ["-lc", 'pkill -f notion-login.py; exec python3 "$0" "$1"', script, tokenFile], { timeout: 330_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim().split("\n").pop() || "Notion login failed");
    const { owner, workspace } = JSON.parse(r.stdout.trim().split("\n").pop());
    if (!owner) throw new Error("Notion didn't say who signed in");
    return { tokenFile, assignee: owner, workspace };
  },

  // Forgets this space's token (not the shared one notion-login.py saves when run by hand). Notion keeps the
  // connection listed in its Settings > Connections until removed there.
  async disconnect(config) {
    if (config.tokenFile) await exec("rm", ["-f", config.tokenFile]);
  },

  // The databases the person shared while connecting.
  async projects(config) {
    const token = await readToken(config);
    const json = await notion(token, "search", { filter: { property: "object", value: "data_source" }, page_size: 100 });
    return json.results.map((d) => ({ id: d.id, name: d.title?.map((t) => t.plain_text).join("") || "Untitled", unusable: missing(d.properties) }));
  },

  async load({ config, onBoard }) {
    const { projects, assignee } = config;
    if (!projects?.length || !assignee) throw new Error('the space\'s config needs "projects" and "assignee"');
    const token = await readToken(config);
    const pages = [];
    for (const dataSource of projects) for (let cursor; ; ) {
      const json = await notion(token, `data_sources/${dataSource}/query`, {
        page_size: 100,
        ...(cursor ? { start_cursor: cursor } : {}),
        filter: {
          and: [
            { property: "Assignee", people: { contains: assignee } },
            { or: STATUSES.map((s) => ({ property: "Status", status: { equals: s } })) },
          ],
        },
      });
      pages.push(...json.results);
      if (!json.has_more) break;
      cursor = json.next_cursor;
    }
    // Done tasks stay until Released, but only ones already on the board: most Done tasks are never Released.
    return pages.filter((p) => p.properties.Status.status?.name !== "Done" || onBoard.has(keyOf(p))).map(toTask);
  },

  // The page whose ID is key ("OI-42") in one of config's databases, or null.
  async find(config, key) {
    const [prefix, n] = key.split("-");
    const token = await readToken(config);
    let failed = 0, error;
    for (const dataSource of config.projects ?? []) {
      // A database without an ID property fails its query; only every one failing is an error.
      const json = await notion(token, `data_sources/${dataSource}/query`, { page_size: 5, filter: { property: "ID", unique_id: { equals: Number(n) } } })
        .catch((e) => { failed++; error = e; return null; });
      const page = json?.results.find((p) => p.properties.ID?.unique_id?.prefix?.toUpperCase() === prefix.toUpperCase());
      if (page) return page;
    }
    if (failed && failed === config.projects.length) throw error;
    return null;
  },

  open(task) {
    exec("open", ["-a", "Notion", task.url]);
  },

  // Run under `herdr-app check`.
  check() {
    const page = {
      id: "abcdef123", url: "u", icon: { type: "icon", icon: { name: "bug", color: "red" } },
      properties: {
        ID: { unique_id: { prefix: "OI", number: 7 } }, "Task name": { type: "title", title: [{ plain_text: "Fix " }, { plain_text: "it" }] },
        "In Flight": { status: { name: "Not started" } }, Priority: { select: { name: "High" } },
        Assignee: { people: [{ id: "p", name: "P", avatar_url: null }] }, "Blocked by": { relation: [{ id: "x" }] }, Status: { status: { name: "Queued" } },
      },
    };
    const t = toTask(page);
    if (!missing({ Assignee: { type: "people" } })?.includes("Status") || missing({ Assignee: { type: "people" }, Status: { type: "status" } }) !== null) throw new Error("notion missing is wrong");
    if (t.key !== "OI-7" || t.title !== "Fix it" || t.status.stage !== "queued" || t.rank[0] !== 0 || t.icon.color !== "ansi1" || t.blockedBy[0] !== "x") throw new Error("notion toTask is wrong");
  },
};

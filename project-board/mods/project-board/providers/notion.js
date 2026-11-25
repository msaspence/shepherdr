// The Notion provider: a Tech Tasks-shaped database (Task name, ID, Status, In Flight, Priority, Assignee,
// Blocked by), read with the token notion-login.py saves. A space's config:
//   { "provider": "notion", "dataSource": "<data source id>", "assignee": "<Notion user id>" }
// The provider contract, and the task shape every provider returns, are documented in providers/index.js.
import { exec, home, readTextFile } from "herdr";

const STATUSES = ["In progress", "Queued", "Done"]; // Released tasks leave the board
const PRIORITY_RANK = { High: 0, Medium: 1, Low: 2 };
const ICON_COLORS = { red: "ansi1", green: "ansi2", yellow: "ansi3", blue: "ansi4", purple: "ansi5", pink: "ansi13", orange: "ansi11", brown: "ansi3" };
const TOKEN = ".config/notion-board/token"; // under home

const keyOf = (p) => {
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
    title: p.properties["Task name"].title.map((t) => t.plain_text).join(""),
    icon,
    status: inFlight ? { name: inFlight.name, stage: stage(inFlight.name) } : null,
    rank: [PRIORITY_RANK[p.properties.Priority?.select?.name] ?? 3, id?.number ?? Infinity],
    people: p.properties.Assignee.people.map((u) => ({ id: u.id, name: u.name, avatar: u.avatar_url })),
    blockedBy: p.properties["Blocked by"].relation.map((r) => r.id),
    url: p.url,
  };
}

export default {
  name: "Notion",
  icon: "mods/project-board/notion.svg",
  setupHint: `Check the token in ~/${TOKEN} (re-run notion-login.py) and the connection`,

  async load({ config, onBoard }) {
    const { dataSource, assignee } = config;
    if (!dataSource || !assignee) throw new Error('the space\'s config needs "dataSource" and "assignee"');
    const token = (await readTextFile(`${home()}/${TOKEN}`)).trim();
    const pages = [];
    for (let cursor; ; ) {
      const res = await fetch(`https://api.notion.com/v1/data_sources/${dataSource}/query`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Notion-Version": "2025-09-03", "Content-Type": "application/json" },
        body: JSON.stringify({
          page_size: 100,
          ...(cursor ? { start_cursor: cursor } : {}),
          filter: {
            and: [
              { property: "Assignee", people: { contains: assignee } },
              { or: STATUSES.map((s) => ({ property: "Status", status: { equals: s } })) },
            ],
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json.message ?? `Notion ${res.status}`);
      pages.push(...json.results);
      if (!json.has_more) break;
      cursor = json.next_cursor;
    }
    // Done tasks stay until Released, but only ones already on the board: most Done tasks are never Released.
    return pages.filter((p) => p.properties.Status.status?.name !== "Done" || onBoard.has(keyOf(p))).map(toTask);
  },

  open(task) {
    exec("open", ["-a", "Notion", task.url]);
  },

  // Run under `herdr-app check`.
  check() {
    const page = {
      id: "abcdef123", url: "u", icon: { type: "icon", icon: { name: "bug", color: "red" } },
      properties: {
        ID: { unique_id: { prefix: "OI", number: 7 } }, "Task name": { title: [{ plain_text: "Fix " }, { plain_text: "it" }] },
        "In Flight": { status: { name: "Not started" } }, Priority: { select: { name: "High" } },
        Assignee: { people: [{ id: "p", name: "P", avatar_url: null }] }, "Blocked by": { relation: [{ id: "x" }] }, Status: { status: { name: "Queued" } },
      },
    };
    const t = toTask(page);
    if (t.key !== "OI-7" || t.title !== "Fix it" || t.status.stage !== "queued" || t.rank[0] !== 0 || t.icon.color !== "ansi1" || t.blockedBy[0] !== "x") throw new Error("notion toTask is wrong");
  },
};

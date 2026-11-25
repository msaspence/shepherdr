// The panel's tabs: the person's chosen list, the mods that offer tabs, and loading those mods' code.
//
// A mod offers a tab (and/or Summary lines) by declaring `"context-panel": { "title": "My tab" }` in its mod.json
// and registering on a global from its main.js. Mods share one JS runtime, though they can't import each other:
//   (globalThis.contextPanel ??= {})["<mod>"] = { render?(ctx), summary?(ctx), header? };
// render gives the tab's content, summary a line (or lines) for the Summary tab, header an optional label over
// those lines (a string, or a function of ctx returning one or null). All get ctx = { t, cx, agent, cwd, branch,
// width, state, show(tab), line(id, icon, text, right?) }: cx the panel's, state an object the panel keeps for
// this mod, width the pane's, show switches the panel's tab, line the Summary's own row.
import { appHome, closeOverlay, openOverlay, readTextFile, setShared, shared, writeTextFile } from "herdr";
import { readdir, readFile } from "fs/promises";

export const MOD = "agents-sidebar-context-panel";
// [{ id, title, on }] in the person's order; id is a mod's name, or a built-in tab's.
export const KEY = "agents-sidebar.context-panel-tabs";
const LOADED = "agents-sidebar.context-panel-loaded"; // bumped after mods load, so every panel redraws with them
const LOAD_MS = 500; // how long a mod's loader window stays open
// Built in, on until turned off: Summary (always on) and Herdr's own Files and Changes panels.
const BUILTIN = [{ id: "summary", title: "Summary", on: true }, { id: "files", title: "Files", on: true }, { id: "changes", title: "Changes", on: true }];
export const isBuiltin = (id) => BUILTIN.some((b) => b.id === id);
export const HERDR_TABS = new Set(["files", "changes"]);

export const registry = () => globalThis.contextPanel ?? {};
// The saved list, with any built-in tab it doesn't have yet added at the end.
export const config = () => {
  const c = shared(KEY) ?? [];
  return [...c, ...BUILTIN.filter((b) => !c.some((x) => x.id === b.id))];
};
export const enabledMods = () => config().filter((c) => c.on && !isBuiltin(c.id)).map((c) => c.id);

// Reads every mod.json for tab mods; keeps the person's order and choices, drops mods that are gone and adds
// new ones, on, at the end.
export async function scanTabMods() {
  const dir = `${appHome()}/mods`;
  const found = [];
  for (const mod of (await readdir(dir).catch(() => [])).sort()) {
    if (mod === MOD) continue;
    try {
      const decl = JSON.parse(await readFile(`${dir}/${mod}/mod.json`, "utf8"))["context-panel"];
      if (decl) found.push({ id: mod, title: decl.title ?? mod });
    } catch {}
  }
  const prev = config();
  const title = (id) => found.find((f) => f.id === id)?.title;
  const next = [
    ...prev.filter((c) => isBuiltin(c.id) || title(c.id)).map((c) => ({ ...c, title: isBuiltin(c.id) ? c.title : title(c.id) })),
    ...found.filter((f) => !prev.some((c) => c.id === f.id)).map((f) => ({ ...f, on: true })),
  ];
  if (JSON.stringify(next) !== JSON.stringify(shared(KEY))) setShared(KEY, next);
}

// A mod's code runs only once a copy of it is shown, so each mod that hasn't registered, or whose .js files
// changed since it was opened (panels check every few seconds), is opened in a 1px frameless window (props["context-panel"] = "load"; it draws
// nothing there) and closed again; its module code registers as it loads.
const loaded = new Map(); // mod -> its .js files' text when it was opened
// Every top-level .js file of a mod, so a change to any module it imports counts.
const sourceOf = async (folder) => {
  const files = (await readdir(folder)).filter((f) => f.endsWith(".js")).sort();
  return (await Promise.all(files.map((f) => readFile(`${folder}/${f}`, "utf8")))).join("\0");
};
const loading = new Set();
export async function loadTabMods(cx, mods) {
  const dir = `${appHome()}/mods`;
  const opened = [];
  for (const mod of mods) {
    if (loading.has(mod)) continue;
    try {
      const source = await sourceOf(`${dir}/${mod}`);
      if (registry()[mod] && loaded.get(mod) === source) continue;
      loaded.set(mod, source);
      loading.add(mod);
      opened.push([mod, openOverlay({ mod, kind: "window", frame: "none", width: 1, height: 1, at: { x: 0, y: 0 }, props: { "context-panel": "load" } })]);
    } catch {}
  }
  if (!opened.length) return;
  cx.timer.after(LOAD_MS, () => {
    for (const [mod, id] of opened) { closeOverlay(id); loading.delete(mod); }
    setShared(LOADED, Date.now());
  });
}

// Herdr's Files and Changes panels as views to nest (cx.new). A mod can only import its own files, so each one's
// main.js (one file, importing only gpui-kit, gpui-base and herdr) is copied here as herdr-<name>.js (git-ignored)
// and imported; the copy is rewritten when Herdr ships a new version, which loads when this mod next reloads.
const views = new Map(); // name -> Promise<ViewClass>
export function herdrView(name) {
  if (!views.has(name)) {
    const load = (async () => {
      const src = await readTextFile(`${appHome()}/mods/${name}/main.js`);
      if (src == null) throw new Error(`Herdr's ${name} panel isn't installed`);
      const path = `${appHome()}/mods/${MOD}/herdr-${name}.js`;
      const old = await readTextFile(path);
      if (old !== src) await writeTextFile(path, src, old);
      return (await (name === "files" ? import("./herdr-files.js") : import("./herdr-changes.js"))).default;
    })();
    load.catch(() => views.delete(name)); // try again next time
    views.set(name, load);
  }
  return views.get(name);
}

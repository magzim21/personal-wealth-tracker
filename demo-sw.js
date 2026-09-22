// Ledgerbook demo server — a service worker that stands in for server.mjs on the online demo.
//
// On a static host (GitHub Pages) there is no server, so the app would fall back to plain browser
// storage and lose multi-ledger, snapshots, the folder picker and the history guard. This worker
// answers the same /api/* routes as server.mjs, inside the browser, over a small virtual file
// system kept in IndexedDB. Nothing is uploaded: every byte stays in this browser.
//
// It mirrors server.mjs route-for-route (same status codes, same JSON fields); scripts/test-demo-api.mjs
// replays one scenario against both and fails CI on drift. Differences, all deliberate:
//   • paths are virtual ("/iCloud Drive/…", "/Documents/…", "/Desktop/…"), not your disk;
//   • /api/version reports { demo: true } and no git info;
//   • /api/pick can't show a native dialog — the app opens its own picker over GET /api/fs instead;
//   • /api/rates uses only the free no-key fiat source (no Twelve Data key here);
//   • GET /api/fs?dir=… lists a virtual folder, POST /api/fs {op:"mkdir",path} makes one (demo-only).
// If a real server answers /api/ping on this origin, the worker steps aside and passes everything through.
//
// The core (makeApi + memFs) is plain JS with no browser APIs, so the parity test can run it in Node.

const PROJECT = "personal-wealth-tracker";
const SNAP_KEEP = 300;
const CONFIG_FILE = "/.pwt/config.json";          // hidden from the picker (dot-folder)
const ROOTS = ["/iCloud Drive", "/Documents", "/Desktop"];
const DEFAULT_ROOT = "/iCloud Drive/PersonalWealthTracker";
const PALETTE = ["#2f7d5b", "#3563b8", "#b0741a", "#8a4fbe", "#b23a48", "#2a8f8f", "#6b8f2a", "#c25d8a", "#4a6fa5", "#a0562a", "#5a5f8f", "#3f8f5a"];
const CONFIG_SCHEMA = 2;

const uid = () => Math.random().toString(36).slice(2, 10);
const slug = (s) => ((s || "ledger").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ledger");
const nextColor = (ledgers) => { const used = new Set(ledgers.map((l) => l.color)); return PALETTE.find((c) => !used.has(c)) || PALETTE[ledgers.length % PALETTE.length]; };
// posix-style path helpers (the virtual FS always uses "/")
const norm = (p) => "/" + String(p || "").split("/").filter((s) => s && s !== ".").join("/");
const join = (...a) => norm(a.join("/"));
const dirname = (p) => { const s = norm(p).split("/"); s.pop(); return s.join("/") || "/"; };
const basename = (p, ext) => { let b = norm(p).split("/").pop() || ""; if (ext && b.endsWith(ext)) b = b.slice(0, -ext.length); return b; };

const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };
// Same token as server.mjs: first 16 hex chars of SHA-256 over the UTF-8 bytes, quoted.
async function etagOf(text) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return '"' + [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16) + '"';
}

// Identical to server.mjs: refuse a write that drops a transaction id or shrinks the audit log.
function historyLoss(prev, next) {
  const ids = (o) => new Set((o && Array.isArray(o.transactions) ? o.transactions : []).map((t) => t && t.id).filter(Boolean));
  const before = ids(prev), after = ids(next);
  const missing = [...before].filter((id) => !after.has(id));
  if (missing.length) return `Refusing to drop ${missing.length} existing transaction id(s) (e.g. ${missing.slice(0, 3).join(", ")}) — history is append-only, so archive with a tombstone instead of deleting.`;
  const alen = (o) => (o && Array.isArray(o.auditLog) ? o.auditLog.length : 0);
  if (alen(next) < alen(prev)) return `Refusing to shrink the audit log from ${alen(prev)} to ${alen(next)} entries — it is append-only.`;
  return "";
}

// In-memory file system with the same interface as the IndexedDB one (used by the parity test).
function memFs() {
  const m = new Map(); // path -> { kind: "file"|"dir", data }
  const mkdir = async (d) => { d = norm(d); while (d !== "/") { if (!m.has(d)) m.set(d, { kind: "dir" }); d = dirname(d); } };
  return {
    async read(p) { const e = m.get(norm(p)); return e && e.kind === "file" ? e.data : null; },
    async write(p, data) { p = norm(p); await mkdir(dirname(p)); m.set(p, { kind: "file", data: String(data) }); },
    async exists(p) { return m.has(norm(p)); },
    mkdir,
    async list(d) {
      const pre = d === "/" ? "/" : norm(d) + "/", out = new Map();
      for (const [k, e] of m) if (k.startsWith(pre) && k !== pre) { const rest = k.slice(pre.length), seg = rest.split("/")[0]; out.set(seg, rest.includes("/") ? "dir" : e.kind); }
      return [...out].map(([name, kind]) => ({ name, kind }));
    },
    async rm(p) { p = norm(p); for (const k of [...m.keys()]) if (k === p || k.startsWith(p + "/")) m.delete(k); },
  };
}

// The API. `fs` is the virtual file system; `net` is an optional fetch for the rates source.
function makeApi(fs, { appVersion = "unknown", net = null } = {}) {
  const loadConfig = async () => { try { return JSON.parse(await fs.read(CONFIG_FILE)) || {}; } catch { return {}; } };
  const saveConfig = (c) => fs.write(CONFIG_FILE, JSON.stringify(c, null, 2));
  function migrate(c) {
    if (c && Array.isArray(c.ledgers)) {
      c.schema = CONFIG_SCHEMA; c.ledgersRoot = c.ledgersRoot || DEFAULT_ROOT;
      c.ledgers.forEach((l, i) => { if (!l.id) l.id = uid(); if (!l.color) l.color = PALETTE[i % PALETTE.length]; if (!l.snapshotDir) l.snapshotDir = join(dirname(l.path), "snapshots"); });
      if (!c.current && c.ledgers[0]) c.current = c.ledgers[0].id;
      const cur = c.ledgers.find((l) => l.id === c.current); if (cur && !cur.lastOpened) cur.lastOpened = Date.now();
      return c;
    }
    const path = join(DEFAULT_ROOT, "ledger.json"), id = uid();
    return { schema: CONFIG_SCHEMA, ledgersRoot: DEFAULT_ROOT, current: id, ledgers: [{ id, name: "My ledger", path, snapshotDir: join(DEFAULT_ROOT, "snapshots"), color: PALETTE[0], lastOpened: Date.now() }] };
  }
  // The service worker can be stopped at any moment, so the registry is re-read on every request
  // (it's tiny) instead of being held in memory like server.mjs does.
  let booted = false;
  async function config() {
    if (!booted) { for (const r of ROOTS) await fs.mkdir(r); booted = true; }
    const raw = await loadConfig(), c = migrate(raw);
    if (JSON.stringify(raw) !== JSON.stringify(c)) await saveConfig(c);
    return c;
  }
  const curEntry = (c) => c.ledgers.find((l) => l.id === c.current) || c.ledgers[0];
  const snapOf = (e) => e.snapshotDir || join(dirname(e.path), "snapshots");
  async function lastTxDate(p) {
    try {
      const j = JSON.parse(await fs.read(p));
      const txs = j && Array.isArray(j.transactions) ? j.transactions : [];
      let mx = ""; for (const t of txs) { if (t && !t.deleted && t.date && t.date > mx) mx = t.date; }
      return mx || null;
    } catch { return null; }
  }
  async function writeSnapshot(body, snap) {
    try {
      await fs.mkdir(snap);
      const list = async () => (await fs.list(snap)).filter((f) => f.kind === "file" && f.name.startsWith(PROJECT + "_") && f.name.endsWith(".json")).map((f) => f.name).sort();
      const before = await list();
      if (before.length && (await fs.read(join(snap, before[before.length - 1]))) === body) return;
      await fs.write(join(snap, `${PROJECT}_${stamp()}.json`), body);
      const after = await list();
      for (const f of after.slice(0, Math.max(0, after.length - SNAP_KEEP))) await fs.rm(join(snap, f));
    } catch { /* a snapshot failure must never block a save */ }
  }

  const res = (status, body = "", headers = {}) => ({ status, body, headers });
  const json = (status, obj, headers = {}) => res(status, JSON.stringify(obj), { "content-type": "application/json", ...headers });
  const parse = (b) => { try { return JSON.parse(b); } catch { return {}; } };

  // req: { method, url (path + query), headers: { lowercase-name: value }, body: string }
  return async function handle(req) {
    const u = new URL(req.url, "http://x"), method = req.method || "GET";
    const h = req.headers || {};

    if (u.pathname === "/api/ping") return res(200, "ok");
    if (u.pathname === "/api/version") return json(200, { appVersion, isRepo: false, stale: false, demo: true });
    if (u.pathname === "/api/pick") return json(200, { cancelled: true });

    if (u.pathname === "/api/fs") {
      if (method === "GET") {
        const dir = norm(u.searchParams.get("dir") || "/");
        if (!(dir === "/" || (await fs.exists(dir)))) return json(404, { error: "no such folder" });
        const entries = (await fs.list(dir)).filter((e) => !e.name.startsWith(".")).sort((a, b) => (a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "dir" ? -1 : 1));
        return json(200, { dir, entries });
      }
      if (method === "POST") {
        const o = parse(req.body);
        if (o.op !== "mkdir" || !String(o.path || "").startsWith("/")) return json(400, { error: "expected {op:'mkdir', path:'/…'}" });
        await fs.mkdir(norm(o.path)); return json(200, { ok: true, path: norm(o.path) });
      }
      return json(405, { error: "method not allowed" });
    }

    if (u.pathname === "/api/ledgers") {
      const cfg = await config();
      if (method === "GET") {
        const ordered = [...cfg.ledgers].sort((a, b) => (a.id === cfg.current ? -1 : b.id === cfg.current ? 1 : (b.lastOpened || 0) - (a.lastOpened || 0)));
        const ledgers = await Promise.all(ordered.map(async (l) => ({ id: l.id, name: l.name, path: l.path, color: l.color, exists: await fs.exists(l.path), current: l.id === cfg.current, lastTx: await lastTxDate(l.path) })));
        return json(200, { ledgersRoot: cfg.ledgersRoot, current: cfg.current, palette: PALETTE, usedColors: cfg.ledgers.map((l) => l.color), ledgers });
      }
      if (method === "POST") {
        const o = parse(req.body);
        const name = (o.name || "New ledger").trim() || "New ledger";
        if (cfg.ledgers.some((l) => (l.name || "").trim().toLowerCase() === name.toLowerCase())) return json(409, { error: `A ledger named “${name}” already exists. Pick a different name.` });
        let color = o.color;
        if (color) { if (cfg.ledgers.some((l) => l.color === color)) return json(409, { error: "That colour is already used by another ledger." }); }
        else color = nextColor(cfg.ledgers);
        const root = (o.dir && String(o.dir).startsWith("/")) ? norm(o.dir) : cfg.ledgersRoot;
        const path = join(root, slug(name) + ".json");
        if (cfg.ledgers.some((l) => l.path === path) || (await fs.exists(path))) return json(409, { error: `A file already exists at ${path}. Pick a different name or folder.` });
        await fs.write(path, "null");
        const e = { id: uid(), name, path, snapshotDir: join(root, "snapshots", basename(path, ".json")), color, lastOpened: Date.now() };
        cfg.ledgers.push(e); cfg.current = e.id; await saveConfig(cfg);
        return json(200, { ok: true, id: e.id, current: cfg.current });
      }
      if (method === "PUT") {
        const o = parse(req.body);
        const e = cfg.ledgers.find((l) => l.id === o.id);
        if (o.op === "switch") { if (!e) return json(404, { error: "no such ledger" }); e.lastOpened = Date.now(); cfg.current = e.id; await saveConfig(cfg); return json(200, { ok: true, current: cfg.current }); }
        if (o.op === "rename") { if (!e) return json(404, { error: "no such ledger" }); e.name = (o.name || e.name).trim() || e.name; await saveConfig(cfg); return json(200, { ok: true }); }
        if (o.op === "color") { if (!e) return json(404, { error: "no such ledger" }); if (cfg.ledgers.some((l) => l.id !== e.id && l.color === o.color)) return json(409, { error: "That colour is already used by another ledger." }); e.color = o.color; await saveConfig(cfg); return json(200, { ok: true }); }
        if (o.op === "remove") {
          if (!e) return json(404, { error: "no such ledger" });
          const snapToDel = (o.snapshots && e.snapshotDir) ? e.snapshotDir : null; // the ledger file itself always stays
          cfg.ledgers = cfg.ledgers.filter((l) => l.id !== e.id);
          if (!cfg.ledgers.length) { const id = uid(), path = join(cfg.ledgersRoot, "ledger.json"); cfg.ledgers = [{ id, name: "My ledger", path, snapshotDir: join(cfg.ledgersRoot, "snapshots", "ledger"), color: PALETTE[0] }]; cfg.current = id; if (!(await fs.exists(path))) await fs.write(path, "null"); }
          else if (cfg.current === e.id) cfg.current = cfg.ledgers[0].id;
          await saveConfig(cfg);
          if (snapToDel) await fs.rm(snapToDel);
          return json(200, { ok: true, current: cfg.current });
        }
        return json(400, { error: "unknown op" });
      }
      return json(405, { error: "method not allowed" });
    }

    if (u.pathname === "/api/location") {
      const cfg = await config(), e = curEntry(cfg);
      if (method === "GET")
        return json(200, { ledgerPath: e.path, snapshotDir: snapOf(e), ledgerExists: await fs.exists(e.path),
          defaults: { icloud: join(DEFAULT_ROOT, "ledger.json"), home: "/Documents/PersonalWealthTracker/ledger.json", cwd: "/Desktop/Ledgerbook/ledger.json" } });
      if (method === "PUT") {
        const o = parse(req.body);
        if (o.ledgerPath !== undefined) { if (!String(o.ledgerPath).startsWith("/")) return json(400, { error: "ledgerPath must be an absolute path" }); e.path = norm(o.ledgerPath);
          if (o.snapshotDir === undefined) e.snapshotDir = join(dirname(e.path), "snapshots"); }
        if (o.snapshotDir !== undefined) { if (!String(o.snapshotDir).startsWith("/")) return json(400, { error: "snapshotDir must be an absolute path" }); e.snapshotDir = norm(o.snapshotDir); }
        await saveConfig(cfg); await fs.mkdir(dirname(e.path));
        return json(200, { ledgerPath: e.path, snapshotDir: snapOf(e), ledgerExists: await fs.exists(e.path) });
      }
      return json(405, { error: "method not allowed" });
    }

    if (u.pathname === "/api/rates") {
      const symbol = u.searchParams.get("symbol") || "";
      try {
        if (!net) throw 0;
        const j = await (await net("https://open.er-api.com/v6/latest/USD")).json();
        const v = j && j.rates && j.rates[symbol.split("/")[0]];
        return json(200, { symbol, rate: v ? 1 / v : 0 });
      } catch { return json(502, { rate: 0 }); }
    }

    if (u.pathname === "/api/book" && (method === "GET" || method === "PUT")) {
      const cfg = await config();
      const lid = u.searchParams.get("ledger");
      let entry = curEntry(cfg);
      if (lid) { const found = cfg.ledgers.find((l) => l.id === lid); if (!found) return json(409, { error: "wrong-ledger", message: "That ledger is no longer in the registry — reload." }); entry = found; }
      const file = entry.path, snap = snapOf(entry);
      const onDisk = await fs.read(file);
      if (method === "GET") { const d = onDisk == null ? "null" : onDisk; return res(200, d, { "content-type": "application/json", etag: await etagOf(d) }); }
      const ifMatch = h["if-match"];
      if (ifMatch) {
        const curTag = await etagOf(onDisk == null ? "null" : onDisk);
        if (ifMatch !== curTag) return json(409, { error: "conflict", message: "The ledger on disk is newer than the version you edited." }, { etag: curTag });
      }
      const b = req.body || "";
      const replace = u.searchParams.get("replace") === "1";
      if (!replace && onDisk != null) {
        let prev = null, next = null;
        try { prev = JSON.parse(onDisk); } catch { prev = null; }
        try { next = JSON.parse(b); } catch { return json(400, { error: "bad-json", message: "Request body is not valid JSON." }); }
        if (prev && typeof prev === "object") {
          const drop = historyLoss(prev, next);
          if (drop) return json(409, { error: "history-loss", message: drop + " Pass ?replace=1 only when you mean to replace the whole book (import / restore)." }, { etag: await etagOf(onDisk) });
        }
      }
      if (replace && onDisk != null) await writeSnapshot(onDisk, snap);
      await fs.write(file, b);
      await writeSnapshot(b, snap);
      return res(204, "", { etag: await etagOf(b) });
    }

    return res(404, "not found");
  };
}

// ---- IndexedDB-backed file system (browser only) ----
function idbFs() {
  const db = new Promise((ok, bad) => {
    const r = indexedDB.open("ledgerbook-demo-fs", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("fs");
    r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error);
  });
  const tx = async (mode, fn) => { const d = await db; return new Promise((ok, bad) => {
    const t = d.transaction("fs", mode), s = t.objectStore("fs"); let out; const set = (v) => { out = v; };
    fn(s, set); t.oncomplete = () => ok(out); t.onerror = () => bad(t.error); t.onabort = () => bad(t.error); }); };
  const under = (p) => IDBKeyRange.bound(p + "/", p + "/￿");
  const mkdirIn = (s, d) => { d = norm(d); while (d !== "/") { s.put({ kind: "dir" }, d); d = dirname(d); } };
  return {
    read: (p) => tx("readonly", (s, set) => { const g = s.get(norm(p)); g.onsuccess = () => set(g.result && g.result.kind === "file" ? g.result.data : null); }),
    write: (p, data) => tx("readwrite", (s) => { p = norm(p); mkdirIn(s, dirname(p)); s.put({ kind: "file", data: String(data), mtime: Date.now() }, p); }),
    exists: (p) => tx("readonly", (s, set) => { const g = s.getKey(norm(p)); g.onsuccess = () => set(g.result !== undefined); }),
    mkdir: (d) => tx("readwrite", (s) => mkdirIn(s, d)),
    list: (d) => tx("readonly", (s, set) => {
      const pre = d === "/" ? "/" : norm(d) + "/", out = new Map();
      const c = s.openCursor(IDBKeyRange.bound(pre, pre + "￿"));
      c.onsuccess = () => { const cur = c.result; if (!cur) return set([...out].map(([name, kind]) => ({ name, kind })));
        const rest = String(cur.key).slice(pre.length); if (rest) { const seg = rest.split("/")[0]; out.set(seg, rest.includes("/") ? "dir" : cur.value.kind); } cur.continue(); };
    }),
    rm: (p) => tx("readwrite", (s) => { p = norm(p); s.delete(p); s.delete(under(p)); }),
  };
}

// ---- service worker wiring (skipped when loaded by the Node test) ----
if (typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope) {
  self.addEventListener("install", () => self.skipWaiting());
  self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
  let api = null, realServer = null, queue = Promise.resolve();
  const getApi = async () => {
    if (api) return api;
    let appVersion = "unknown";
    try { const m = (await (await fetch("./", { cache: "no-store" })).text()).match(/const VERSION="(v\d+)"/); if (m) appVersion = m[1]; } catch {}
    return (api = makeApi(idbFs(), { appVersion, net: (u) => fetch(u, { cache: "no-store" }) }));
  };
  self.addEventListener("fetch", (e) => {
    const u = new URL(e.request.url);
    if (u.origin !== self.location.origin || !u.pathname.startsWith("/api/")) return; // everything else: straight to the network
    e.respondWith((async () => {
      // A real server on this origin always wins — the demo never shadows it.
      if (realServer === null) realServer = fetch("/api/ping", { cache: "no-store" }).then((r) => r.ok).catch(() => false);
      if (await realServer) return fetch(e.request);
      const req = { method: e.request.method, url: u.pathname + u.search, headers: Object.fromEntries(e.request.headers), body: await e.request.text() };
      // One request at a time, so a check-then-write (If-Match, history guard) can't interleave across tabs.
      const run = queue.then(async () => (await getApi())(req));
      queue = run.catch(() => {});
      const r = await run;
      return new Response(r.status === 204 ? null : r.body, { status: r.status, headers: r.headers });
    })());
  });
} else if (typeof module !== "undefined") {
  module.exports = { makeApi, memFs, historyLoss };
}

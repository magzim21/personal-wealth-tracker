// Ledgerbook local server (Node, zero dependencies).
// Serves index.html and owns the data files. The internet is touched only to
// proxy exchange-rate lookups when you ask for them.
//
// Many ledgers: config.json holds a registry { ledgersRoot, current, ledgers:[{id,name,path,snapshotDir,color}] }.
// The server always reads/writes the CURRENT ledger; /api/ledgers lists, creates, switches, renames, recolours
// and removes them. A v1 single-ledger config (or a fresh start) is migrated into the registry WITHOUT moving
// any file. New ledgers are created under ledgersRoot (iCloud Drive when present, else ~/PersonalWealthTracker).
//   ledger override : $LEDGER_PATH   (applies to the current ledger)
//   snapshot override: $SNAPSHOT_DIR  (applies to the current ledger)
// A snapshot is written on every save (deduped; newest SNAP_KEEP retained).
import { createServer } from "http";
import { readFile, writeFile, mkdir, readdir, unlink } from "fs/promises";
import { existsSync, readFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, basename } from "path";
import { execSync, execFileSync } from "child_process";
import { createHash } from "crypto";

const PROJECT = "personal-wealth-tracker";
// Single source of truth: the version lives ONLY in index.html's VERSION. Read it once at startup
// (frozen for this process) so the frontend can detect a stale, not-yet-restarted server.
const APP_VERSION = (() => { try { const m = readFileSync("index.html", "utf8").match(/const VERSION="(v\d+)"/); return m ? m[1] : "unknown"; } catch { return "unknown"; } })();
const PORT = process.env.PORT ? Number(process.env.PORT) : 8123;
const SNAP_KEEP = 300;
const CONFIG_DIR = process.env.PWT_CONFIG_DIR || join(process.cwd(), ".pwt"); // project-local (git-ignored), not a hidden system folder
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const ICLOUD_BASE = join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs");
const ICLOUD_DIR = join(ICLOUD_BASE, "PersonalWealthTracker");
const HOME_DIR = join(homedir(), "PersonalWealthTracker");
// New ledgers land here. Prefer iCloud Drive (syncs across the user's Macs) when it actually exists,
// otherwise a plain home folder so it also works off-Mac / without iCloud.
const DEFAULT_ROOT = existsSync(ICLOUD_BASE) ? ICLOUD_DIR : HOME_DIR;
// A fixed set of distinct identity colours; each ledger gets a different one so they're tellable apart.
const PALETTE = ["#2f7d5b", "#3563b8", "#b0741a", "#8a4fbe", "#b23a48", "#2a8f8f", "#6b8f2a", "#c25d8a", "#4a6fa5", "#a0562a", "#5a5f8f", "#3f8f5a"];
const CONFIG_SCHEMA = 2;

const uid = () => Math.random().toString(36).slice(2, 10);
const slug = (s) => ((s || "ledger").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "ledger");
const nextColor = (ledgers) => { const used = new Set(ledgers.map((l) => l.color)); return PALETTE.find((c) => !used.has(c)) || PALETTE[ledgers.length % PALETTE.length]; };

async function loadConfig() { try { return JSON.parse(await readFile(CONFIG_FILE, "utf8")); } catch { return {}; } }
async function saveConfig(c) { await mkdir(CONFIG_DIR, { recursive: true }); await writeFile(CONFIG_FILE, JSON.stringify(c, null, 2)); }

// Bring any older config shape up to the registry, without moving a single file on disk.
function migrate(c) {
  if (c && Array.isArray(c.ledgers)) {
    c.schema = CONFIG_SCHEMA; c.ledgersRoot = c.ledgersRoot || DEFAULT_ROOT;
    c.ledgers.forEach((l, i) => { if (!l.id) l.id = uid(); if (!l.color) l.color = PALETTE[i % PALETTE.length]; if (!l.snapshotDir) l.snapshotDir = join(dirname(l.path), "snapshots"); });
    if (!c.current && c.ledgers[0]) c.current = c.ledgers[0].id;
    return c;
  }
  // v1 single-ledger config, or a fresh start: capture the currently-resolved ledger as the first entry.
  const oldPath = process.env.LEDGER_PATH || (c && c.ledgerPath) || (existsSync(join(process.cwd(), "ledger.json")) ? join(process.cwd(), "ledger.json") : join(DEFAULT_ROOT, "ledger.json"));
  const oldSnap = process.env.SNAPSHOT_DIR || (c && c.snapshotDir) || join(dirname(oldPath), "snapshots");
  const id = uid();
  return { schema: CONFIG_SCHEMA, ledgersRoot: (c && c.ledgersRoot) || DEFAULT_ROOT, current: id, ledgers: [{ id, name: "My ledger", path: oldPath, snapshotDir: oldSnap, color: PALETTE[0] }] };
}

let cfg = migrate(await loadConfig());
await saveConfig(cfg); // persist the migrated registry once at startup

const curEntry = () => cfg.ledgers.find((l) => l.id === cfg.current) || cfg.ledgers[0];
const pathOf = (e) => process.env.LEDGER_PATH || e.path;
const snapOf = (e) => process.env.SNAPSHOT_DIR || e.snapshotDir || join(dirname(pathOf(e)), "snapshots");
let LEDGER = pathOf(curEntry());
let SNAPDIR = snapOf(curEntry());
const useCurrent = () => { const e = curEntry(); LEDGER = pathOf(e); SNAPDIR = snapOf(e); };

const stamp = () => { const d = new Date(), p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; };

async function writeSnapshot(body) {
  try {
    await mkdir(SNAPDIR, { recursive: true });
    const list = () => readdir(SNAPDIR).then((fs) => fs.filter((f) => f.startsWith(PROJECT + "_") && f.endsWith(".json")).sort());
    const before = await list();
    if (before.length) { const last = await readFile(join(SNAPDIR, before[before.length - 1]), "utf8").catch(() => null); if (last === body) return; }
    await writeFile(join(SNAPDIR, `${PROJECT}_${stamp()}.json`), body);
    const after = await list();
    for (const f of after.slice(0, Math.max(0, after.length - SNAP_KEEP))) await unlink(join(SNAPDIR, f)).catch(() => {});
  } catch { /* a snapshot failure must never block a save */ }
}

const body = (req) => new Promise((r) => { let b = ""; req.on("data", (c) => (b += c)); req.on("end", () => r(b)); });
const json = (res, code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
// Optimistic-concurrency token: a version tag derived from the file's bytes. Changes on every
// save, so a client that PUTs with a stale If-Match is refused (409) — a stale in-memory copy
// (e.g. a background tab's beforeunload flush) can never clobber a fresher file on disk.
const etagOf = (buf) => '"' + createHash("sha256").update(buf).digest("hex").slice(0, 16) + '"';
const NULL = Buffer.from("null");

createServer(async (req, res) => {
  const u = new URL(req.url, "http://x");

  if (u.pathname === "/api/ping") { res.writeHead(200); return res.end("ok"); }

  if (u.pathname === "/api/version") {
    const git = (c) => { try { return execSync("git " + c, { cwd: process.cwd(), stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return ""; } };
    if (git("rev-parse --is-inside-work-tree") !== "true") return json(res, 200, { appVersion: APP_VERSION, isRepo: false });
    return json(res, 200, { appVersion: APP_VERSION, isRepo: true, commit: git("rev-parse --short HEAD"), tag: git("describe --tags --exact-match HEAD"), date: git("show -s --format=%cs HEAD"), dirty: git("status --porcelain") !== "" });
  }

  if (u.pathname === "/api/pick") {
    // Native macOS chooser via osascript (works because the server runs on the user's Mac).
    const kind = u.searchParams.get("kind") || "folder";
    const script = kind === "file"
      ? 'POSIX path of (choose file with prompt "Locate your ledger file")'
      : 'POSIX path of (choose folder with prompt "Choose a folder")';
    try {
      const p = execFileSync("osascript", ["-e", script], { stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
      return json(res, 200, { path: p });
    } catch { return json(res, 200, { cancelled: true }); }
  }

  // ---- ledger registry: list / create / switch / rename / recolour / remove ----
  if (u.pathname === "/api/ledgers") {
    if (req.method === "GET")
      return json(res, 200, { ledgersRoot: cfg.ledgersRoot, current: cfg.current, palette: PALETTE, usedColors: cfg.ledgers.map((l) => l.color),
        ledgers: cfg.ledgers.map((l) => ({ id: l.id, name: l.name, path: l.path, color: l.color, exists: existsSync(pathOf(l)), current: l.id === cfg.current })) });
    if (req.method === "POST") {
      let o = {}; try { o = JSON.parse(await body(req)); } catch {}
      const name = (o.name || "New ledger").trim() || "New ledger";
      let color = o.color;
      if (color) { if (cfg.ledgers.some((l) => l.color === color)) return json(res, 409, { error: "That colour is already used by another ledger." }); }
      else color = nextColor(cfg.ledgers);
      const root = cfg.ledgersRoot; let bn = slug(name), path = join(root, bn + ".json"), n = 1;
      while (cfg.ledgers.some((l) => l.path === path) || existsSync(path)) path = join(root, bn + "-" + (++n) + ".json");
      try { await mkdir(dirname(path), { recursive: true }); if (!existsSync(path)) await writeFile(path, "null"); } catch (e) { return json(res, 500, { error: String(e) }); }
      const e = { id: uid(), name, path, snapshotDir: join(root, "snapshots", basename(path, ".json")), color };
      cfg.ledgers.push(e); cfg.current = e.id; await saveConfig(cfg); useCurrent();
      return json(res, 200, { ok: true, id: e.id, current: cfg.current });
    }
    if (req.method === "PUT") {
      let o = {}; try { o = JSON.parse(await body(req)); } catch {}
      const e = cfg.ledgers.find((l) => l.id === o.id);
      if (o.op === "switch") { if (!e) return json(res, 404, { error: "no such ledger" }); cfg.current = e.id; await saveConfig(cfg); useCurrent(); return json(res, 200, { ok: true, current: cfg.current }); }
      if (o.op === "rename") { if (!e) return json(res, 404, { error: "no such ledger" }); e.name = (o.name || e.name).trim() || e.name; await saveConfig(cfg); return json(res, 200, { ok: true }); }
      if (o.op === "color") { if (!e) return json(res, 404, { error: "no such ledger" }); if (cfg.ledgers.some((l) => l.id !== e.id && l.color === o.color)) return json(res, 409, { error: "That colour is already used by another ledger." }); e.color = o.color; await saveConfig(cfg); return json(res, 200, { ok: true }); }
      if (o.op === "remove") {
        if (!e) return json(res, 404, { error: "no such ledger" });
        cfg.ledgers = cfg.ledgers.filter((l) => l.id !== e.id); // unregister only — the file on disk is left untouched
        if (!cfg.ledgers.length) { const id = uid(), path = join(cfg.ledgersRoot, "ledger.json"); cfg.ledgers = [{ id, name: "My ledger", path, snapshotDir: join(cfg.ledgersRoot, "snapshots", "ledger"), color: PALETTE[0] }]; cfg.current = id; try { await mkdir(dirname(path), { recursive: true }); if (!existsSync(path)) await writeFile(path, "null"); } catch {} }
        else if (cfg.current === e.id) cfg.current = cfg.ledgers[0].id;
        await saveConfig(cfg); useCurrent(); return json(res, 200, { ok: true, current: cfg.current });
      }
      return json(res, 400, { error: "unknown op" });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  if (u.pathname === "/api/location") {
    const e = curEntry();
    if (req.method === "GET")
      return json(res, 200, { ledgerPath: pathOf(e), snapshotDir: snapOf(e), ledgerExists: existsSync(pathOf(e)),
        defaults: { icloud: join(ICLOUD_DIR, "ledger.json"), home: join(HOME_DIR, "ledger.json"), cwd: join(process.cwd(), "ledger.json") } });
    if (req.method === "PUT") {
      let o = {}; try { o = JSON.parse(await body(req)); } catch {}
      if (o.ledgerPath !== undefined) { if (!String(o.ledgerPath).startsWith("/")) return json(res, 400, { error: "ledgerPath must be an absolute path" }); e.path = o.ledgerPath;
        if (o.snapshotDir === undefined) e.snapshotDir = join(dirname(e.path), "snapshots"); }
      if (o.snapshotDir !== undefined) { if (!String(o.snapshotDir).startsWith("/")) return json(res, 400, { error: "snapshotDir must be an absolute path" }); e.snapshotDir = o.snapshotDir; }
      try { await saveConfig(cfg); useCurrent(); await mkdir(dirname(LEDGER), { recursive: true }); } catch (err) { return json(res, 500, { error: String(err) }); }
      return json(res, 200, { ledgerPath: pathOf(e), snapshotDir: snapOf(e), ledgerExists: existsSync(pathOf(e)) });
    }
    return json(res, 405, { error: "method not allowed" });
  }

  if (u.pathname === "/api/rates") {
    const symbol = u.searchParams.get("symbol") || "";
    const key = process.env.TWELVEDATA_API_KEY;
    res.setHeader("content-type", "application/json");
    try {
      if (key) { const up = await fetch("https://api.twelvedata.com/exchange_rate?symbol=" + encodeURIComponent(symbol) + "&apikey=" + encodeURIComponent(key)); res.writeHead(200); return res.end(await up.text()); }
      const cur = symbol.split("/")[0];
      const up = await fetch("https://open.er-api.com/v6/latest/USD");
      const j = await up.json();
      const v = j && j.rates && j.rates[cur];
      res.writeHead(200); return res.end(JSON.stringify({ symbol, rate: v ? 1 / v : 0 }));
    } catch { res.writeHead(502); return res.end(JSON.stringify({ rate: 0 })); }
  }

  if (u.pathname === "/api/book") {
    if (req.method === "GET") {
      let d; try { d = await readFile(LEDGER); } catch { d = NULL; }
      res.writeHead(200, { "content-type": "application/json", "etag": etagOf(d) });
      return res.end(d);
    }
    if (req.method === "PUT") {
      // Optimistic concurrency: if the client sent the revision it edited (If-Match), the file
      // on disk must still be at that revision. If it moved on (a newer write landed first),
      // refuse with 409 and leave the file untouched — the fresher version wins.
      const ifMatch = req.headers["if-match"];
      if (ifMatch) {
        let cur; try { cur = await readFile(LEDGER); } catch { cur = NULL; }
        const curTag = etagOf(cur);
        if (ifMatch !== curTag) {
          res.writeHead(409, { "content-type": "application/json", "etag": curTag });
          return res.end(JSON.stringify({ error: "conflict", message: "The ledger on disk is newer than the version you edited." }));
        }
      }
      const b = await body(req);
      try { await mkdir(dirname(LEDGER), { recursive: true }); await writeFile(LEDGER, b); } catch (e) { res.writeHead(500); return res.end(String(e)); }
      writeSnapshot(b);
      res.writeHead(204, { "etag": etagOf(Buffer.from(b)) }); return res.end();
    }
  }

  const p = u.pathname === "/" ? "/index.html" : u.pathname;
  try {
    const d = await readFile("." + p);
    const ct = p.endsWith(".html") ? "text/html; charset=utf-8" : (p.endsWith(".mjs") || p.endsWith(".js")) ? "text/javascript" : "application/octet-stream";
    res.writeHead(200, { "content-type": ct, "cache-control": "no-store" });
    res.end(d);
  } catch { res.writeHead(404); res.end("not found"); }
}).listen(PORT, "127.0.0.1", () => console.log(`Ledgerbook → http://127.0.0.1:${PORT}\n  ledger:    ${curEntry().name} — ${LEDGER}\n  snapshots: ${SNAPDIR}`));

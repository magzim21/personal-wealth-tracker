// Ledgerbook local server (Node, zero dependencies).
// Serves index.html and owns the data file. The internet is touched only to
// proxy exchange-rate lookups when you ask for them.
//
// Storage resolves in this order (documented as "fallback paths"):
//   ledger  : $LEDGER_PATH  ->  config.json ledgerPath  ->  ./ledger.json (if present)  ->  iCloud Drive
//   snapshot: $SNAPSHOT_DIR ->  config.json snapshotDir ->  <ledger dir>/snapshots
// A snapshot is written on every save (deduped; newest SNAP_KEEP retained).
import { createServer } from "http";
import { readFile, writeFile, mkdir, readdir, unlink } from "fs/promises";
import { existsSync } from "fs";
import { homedir } from "os";
import { dirname, join } from "path";
import { execSync, execFileSync } from "child_process";
import { createHash } from "crypto";

const PROJECT = "personal-wealth-tracker";
const APP_VERSION = "v47"; // bump together with index.html's VERSION; the app warns if they differ (restart needed)
const PORT = process.env.PORT ? Number(process.env.PORT) : 8123;
const SNAP_KEEP = 300;
const CONFIG_DIR = process.env.PWT_CONFIG_DIR || join(process.cwd(), ".pwt"); // project-local (git-ignored), not a hidden system folder
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const ICLOUD_DIR = join(homedir(), "Library", "Mobile Documents", "com~apple~CloudDocs", "PersonalWealthTracker");
const HOME_DIR = join(homedir(), "PersonalWealthTracker");

async function loadConfig() { try { return JSON.parse(await readFile(CONFIG_FILE, "utf8")); } catch { return {}; } }
async function saveConfig(c) { await mkdir(CONFIG_DIR, { recursive: true }); await writeFile(CONFIG_FILE, JSON.stringify(c, null, 2)); }

function resolveLedger(c) {
  if (process.env.LEDGER_PATH) return process.env.LEDGER_PATH;
  if (c.ledgerPath) return c.ledgerPath;
  if (existsSync(join(process.cwd(), "ledger.json"))) return join(process.cwd(), "ledger.json");
  return join(ICLOUD_DIR, "ledger.json");
}
function resolveSnapDir(c, ledger) {
  if (process.env.SNAPSHOT_DIR) return process.env.SNAPSHOT_DIR;
  if (c.snapshotDir) return c.snapshotDir;
  return join(dirname(ledger), "snapshots");
}

let cfg = await loadConfig();
let LEDGER = resolveLedger(cfg);
let SNAPDIR = resolveSnapDir(cfg, LEDGER);

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
    return json(res, 200, { appVersion: APP_VERSION, isRepo: true, commit: git("rev-parse --short HEAD"), tag: git("describe --tags --exact-match HEAD"), dirty: git("status --porcelain") !== "" });
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

  if (u.pathname === "/api/location") {
    if (req.method === "GET")
      return json(res, 200, { ledgerPath: LEDGER, snapshotDir: SNAPDIR, ledgerExists: existsSync(LEDGER),
        defaults: { icloud: join(ICLOUD_DIR, "ledger.json"), home: join(HOME_DIR, "ledger.json"), cwd: join(process.cwd(), "ledger.json") } });
    if (req.method === "PUT") {
      let o = {}; try { o = JSON.parse(await body(req)); } catch {}
      if (o.ledgerPath !== undefined) { if (!String(o.ledgerPath).startsWith("/")) return json(res, 400, { error: "ledgerPath must be an absolute path" }); LEDGER = o.ledgerPath;
        if (o.snapshotDir === undefined && !process.env.SNAPSHOT_DIR && !cfg.snapshotDir) SNAPDIR = join(dirname(LEDGER), "snapshots"); }
      if (o.snapshotDir !== undefined) { if (!String(o.snapshotDir).startsWith("/")) return json(res, 400, { error: "snapshotDir must be an absolute path" }); SNAPDIR = o.snapshotDir; }
      cfg = { ...cfg, ledgerPath: LEDGER, snapshotDir: SNAPDIR };
      try { await saveConfig(cfg); await mkdir(dirname(LEDGER), { recursive: true }); } catch (e) { return json(res, 500, { error: String(e) }); }
      return json(res, 200, { ledgerPath: LEDGER, snapshotDir: SNAPDIR, ledgerExists: existsSync(LEDGER) });
    }
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
}).listen(PORT, "127.0.0.1", () => console.log(`Ledgerbook → http://127.0.0.1:${PORT}\n  ledger:    ${LEDGER}\n  snapshots: ${SNAPDIR}`));

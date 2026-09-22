// Parity test: the demo service worker (demo-sw.js) must answer /api/* exactly like server.mjs.
// Replays one scenario against a real server.mjs (in a throwaway HOME/cwd, never your data) and
// against the worker's core over an in-memory FS, then compares status codes, response shapes,
// error codes and ETags step by step. Fails on the first divergence.
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import vm from "node:vm";

const repo = resolve(import.meta.dirname, "..");
const tmp = mkdtempSync(join(tmpdir(), "pwt-parity-"));
const port = 20000 + Math.floor(Math.random() * 20000);

// --- real server, isolated: HOME and cwd are the temp dir, so it can't see iCloud or ./ledger.json
const srv = spawn(process.execPath, [join(repo, "server.mjs")], {
  cwd: tmp, env: { ...process.env, HOME: tmp, PORT: String(port), PWT_CONFIG_DIR: join(tmp, ".pwt"), LEDGER_PATH: "", SNAPSHOT_DIR: "", TWELVEDATA_API_KEY: "" },
  stdio: ["ignore", "pipe", "inherit"],
});
const cleanup = () => { try { srv.kill(); } catch {} try { rmSync(tmp, { recursive: true, force: true }); } catch {} };
await new Promise((ok, bad) => { srv.stdout.on("data", (d) => { if (String(d).includes("Ledgerbook")) ok(); }); srv.on("exit", (c) => bad(new Error("server.mjs exited " + c))); setTimeout(() => bad(new Error("server.mjs did not start")), 8000); });

async function real(method, url, body, headers = {}) {
  const r = await fetch(`http://127.0.0.1:${port}${url}`, { method, headers, body });
  return { status: r.status, etag: r.headers.get("etag"), text: await r.text() };
}

// --- demo core, loaded the way the browser would (plain script), over an in-memory FS
const mod = { exports: {} };
vm.runInNewContext(readFileSync(join(repo, "demo-sw.js"), "utf8"), { module: mod, crypto: globalThis.crypto, TextEncoder, URL, console });
const handle = mod.exports.makeApi(mod.exports.memFs());
async function demo(method, url, body, headers = {}) {
  const r = await handle({ method, url, body: body || "", headers: Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v])) });
  return { status: r.status, etag: r.headers.etag || null, text: r.body };
}

// Shape = keys and value types, recursively; volatile values (ids, paths, times) are ignored.
const shape = (v) => Array.isArray(v) ? [v.length, ...v.map(shape)] : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, shape(v[k])])) : v === null ? "null" : typeof v;
const parse = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
let failures = 0, n = 0;
const ctx = { real: {}, demo: {} }; // per-side values carried between steps (etags, ids)

async function step(name, fn, { sameEtag = false, sameBody = false } = {}) {
  n++;
  const [a, b] = [await fn(real, ctx.real), await fn(demo, ctx.demo)];
  const ja = parse(a.text), jb = parse(b.text);
  const problems = [];
  if (a.status !== b.status) problems.push(`status ${a.status} vs ${b.status}`);
  if (JSON.stringify(shape(ja)) !== JSON.stringify(shape(jb))) problems.push(`shape ${JSON.stringify(shape(ja))} vs ${JSON.stringify(shape(jb))}`);
  const code = (j) => (j && typeof j.error === "string" && !/\s/.test(j.error) ? j.error : undefined);
  if (code(ja) !== code(jb)) problems.push(`error code ${code(ja)} vs ${code(jb)}`);
  if (!!a.etag !== !!b.etag) problems.push(`etag presence ${!!a.etag} vs ${!!b.etag}`);
  if (sameEtag && a.etag !== b.etag) problems.push(`etag ${a.etag} vs ${b.etag}`);
  if (sameBody && a.text !== b.text) problems.push(`body ${a.text.slice(0, 80)} vs ${b.text.slice(0, 80)}`);
  if (problems.length) { failures++; console.error(`FAIL ${name}: ${problems.join("; ")}`); }
  return [a, b];
}

const J = { "content-type": "application/json" };
const book = (txIds, audit) => JSON.stringify({ accounts: [], types: [], transactions: txIds.map((id) => ({ id, date: "2026-09-01" })), auditLog: Array.from({ length: audit }, (_, i) => ({ i })) });

try {
  await step("ping", (f) => f("GET", "/api/ping"), { sameBody: true });
  await step("ledgers: fresh registry", (f) => f("GET", "/api/ledgers"));
  let [a, b] = await step("book: empty", (f) => f("GET", "/api/book"), { sameEtag: true, sameBody: true });
  ctx.real.etag0 = a.etag; ctx.demo.etag0 = b.etag;
  [a, b] = await step("book: first save with If-Match", (f, c) => f("PUT", "/api/book", book(["t1", "t2"], 2), { ...J, "If-Match": c.etag0 }), { sameEtag: true });
  await step("book: stale If-Match → conflict", (f, c) => f("PUT", "/api/book", book(["t1", "t2", "t3"], 3), { ...J, "If-Match": c.etag0 }));
  await step("book: dropping a transaction → history-loss", (f) => f("PUT", "/api/book", book(["t1"], 2), J));
  await step("book: shrinking the audit log → history-loss", (f) => f("PUT", "/api/book", book(["t1", "t2"], 1), J));
  await step("book: bad JSON → 400", (f) => f("PUT", "/api/book", "{nope", J));
  await step("book: superset save", (f) => f("PUT", "/api/book", book(["t1", "t2", "t3"], 3), J), { sameEtag: true });
  await step("book: ?replace=1 may shrink", (f) => f("PUT", "/api/book?replace=1", book([], 0), J), { sameEtag: true });
  await step("book: read back", (f) => f("GET", "/api/book"), { sameEtag: true, sameBody: true });
  await step("book: unknown ledger id → wrong-ledger", (f) => f("GET", "/api/book?ledger=nope"));
  [a, b] = await step("ledgers: create", (f) => f("POST", "/api/ledgers", JSON.stringify({ name: "Second" }), J));
  ctx.real.second = parse(a.text).id; ctx.demo.second = parse(b.text).id;
  await step("ledgers: duplicate name → 409", (f) => f("POST", "/api/ledgers", JSON.stringify({ name: "second" }), J));
  await step("ledgers: colour clash on create → 409", (f) => f("POST", "/api/ledgers", JSON.stringify({ name: "Third", color: "#2f7d5b" }), J));
  [a, b] = await step("ledgers: list shows two, new one current", (f) => f("GET", "/api/ledgers"));
  for (const [side, r] of [["real", a], ["demo", b]]) { const j = parse(r.text); ctx[side].first = j.ledgers.find((l) => !l.current).id; if (j.current !== ctx[side].second) { failures++; console.error(`FAIL ${side}: new ledger is not current`); } }
  await step("book: pinned to a ledger", (f, c) => f("GET", `/api/book?ledger=${c.second}`), { sameEtag: true, sameBody: true });
  await step("ledgers: rename", (f, c) => f("PUT", "/api/ledgers", JSON.stringify({ op: "rename", id: c.second, name: "Renamed" }), J));
  await step("ledgers: colour clash → 409", (f, c) => f("PUT", "/api/ledgers", JSON.stringify({ op: "color", id: c.second, color: "#2f7d5b" }), J));
  await step("ledgers: switch", (f, c) => f("PUT", "/api/ledgers", JSON.stringify({ op: "switch", id: c.first }), J));
  await step("ledgers: switch unknown → 404", (f) => f("PUT", "/api/ledgers", JSON.stringify({ op: "switch", id: "nope" }), J));
  await step("ledgers: unknown op → 400", (f, c) => f("PUT", "/api/ledgers", JSON.stringify({ op: "explode", id: c.first }), J));
  await step("ledgers: wrong method → 405", (f) => f("DELETE", "/api/ledgers"));
  await step("location: read", (f) => f("GET", "/api/location"));
  await step("location: relative path → 400", (f) => f("PUT", "/api/location", JSON.stringify({ ledgerPath: "rel.json" }), J));
  await step("ledgers: remove second (+snapshots)", (f, c) => f("PUT", "/api/ledgers", JSON.stringify({ op: "remove", id: c.second, snapshots: true }), J));
  await step("ledgers: remove the last one → fresh ledger", (f, c) => f("PUT", "/api/ledgers", JSON.stringify({ op: "remove", id: c.first }), J));
  await step("ledgers: after removing all", (f) => f("GET", "/api/ledgers"));
  await step("unknown route → 404", (f) => f("GET", "/api/nope"));
} finally { cleanup(); }

if (failures) { console.error(`demo-sw.js drifted from server.mjs: ${failures} of ${n} steps differ`); process.exit(1); }
console.log(`OK: demo-sw.js matches server.mjs on ${n} API steps`);

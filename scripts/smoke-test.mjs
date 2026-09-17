// Minimal CI smoke test for the single-file app.
//  1. index.html contains a parseable main <script> (catches syntax errors).
//  2. no personal-finance data file is tracked in git.
import { readFileSync } from "node:fs";
import { execSync } from "node:child_process";

const html = readFileSync("index.html", "utf8");
const scripts = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
if (!scripts.length) {
  console.error("FAIL: no inline <script> found in index.html");
  process.exit(1);
}
const main = scripts.slice().sort((a, b) => b.length - a.length)[0];
try {
  // compile-only (does not run): throws on a syntax error
  new Function(main);
} catch (e) {
  console.error("FAIL: index.html main script has a syntax error:", e.message);
  process.exit(1);
}

const tracked = execSync("git ls-files", { encoding: "utf8" }).split("\n");
const dataRe = /(^|\/)(ledger\.json|.*\.ledger\.json|ledgerbook-.*\.(json|csv)|.*wealth.*\.json|.*finances.*\.json)$/i;
const bad = tracked.filter((f) => f && dataRe.test(f));
if (bad.length) {
  console.error("FAIL: personal-finance data files are tracked:", bad);
  process.exit(1);
}

console.log(`OK: ${scripts.length} script block(s), main ${main.length} chars, no data files tracked`);

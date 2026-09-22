// The "Download the desktop app (.zip)" feature ships server.mjs and server.go to the user by
// embedding them as string constants (SERVER_MJS / SERVER_GO) inside index.html. Those copies must
// stay byte-identical to the real server.mjs / server.go files. This script regenerates them from
// the real files; with --check it fails instead of writing, so CI catches drift.
//
//   node scripts/sync-embedded.mjs           # rewrite the embedded copies in index.html
//   node scripts/sync-embedded.mjs --check   # exit 1 if they're out of sync (CI)
import { readFileSync, writeFileSync } from "node:fs";

const check = process.argv.includes("--check");
const mjs = readFileSync("server.mjs", "utf8");
const go = readFileSync("server.go", "utf8");
let html = readFileSync("index.html", "utf8");
const before = html;

// Match a whole double-quoted JS string literal (with escapes) after the const name.
const rep = (src, name, value) => {
  const re = new RegExp(`const ${name}="(?:[^"\\\\]|\\\\.)*";`);
  if (!re.test(src)) { console.error(`Could not find "const ${name}=..." in index.html`); process.exit(2); }
  return src.replace(re, `const ${name}=${JSON.stringify(value)};`);
};

html = rep(html, "SERVER_MJS", mjs);
html = rep(html, "SERVER_GO", go);

if (check) {
  if (html !== before) {
    console.error("Embedded server copies are out of sync with server.mjs / server.go.");
    console.error("Fix: run `node scripts/sync-embedded.mjs` and commit index.html.");
    process.exit(1);
  }
  console.log("Embedded server copies in sync.");
} else {
  if (html !== before) { writeFileSync("index.html", html); console.log("Rewrote embedded SERVER_MJS / SERVER_GO in index.html."); }
  else console.log("Embedded server copies already in sync.");
}

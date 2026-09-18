// CI guard for the AI feature's promise: NUMBERS ARE NEVER SENT to the model.
// This locks the three hard gates in place so a future edit can't quietly weaken them:
//   (A) whitelist — accounts are referenced by letter tokens, never their numeric ids;
//   (B) choke-point — every model-facing byte passes one digit gate before fetch;
//   (C) preview — the sent bytes are shown back to the user.
// It also runs the real scrubDigits() from index.html against digit-laden input and
// fails if a single 0-9 survives.
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

// (B) the outbound request must go to exactly ONE OpenRouter chat endpoint — a single choke-point.
const sends = (html.match(/openrouter\.ai\/api\/v1\/chat\/completions/g) || []).length;
if (sends !== 1) fail(`expected exactly one OpenRouter chat endpoint (the choke-point), found ${sends}`);

// (B) the digit gate must sit in orChat, guarding the model-facing payload, and throw/block.
if (!/const\s+modelFacing\s*=\s*JSON\.stringify\(\{\s*messages\s*,\s*response_format\s*:\s*schema\s*\}\)/.test(html))
  fail("orChat must serialize {messages, response_format} into `modelFacing`");
if (!/if\s*\(\s*\/\[0-9\]\/\.test\(modelFacing\)\s*\)\s*throw/.test(html))
  fail("orChat must throw when a digit reaches `modelFacing` (the redaction gate)");

// (A) accounts must be tokenised to letters (no id leaks); orBuildAccounts must not emit balances.
if (!/function\s+orLetters\(/.test(html)) fail("orLetters() (letter-token references) missing");
const ba = html.match(/function\s+orBuildAccounts\(\)\{[\s\S]*?\n\}/);
if (!ba) fail("orBuildAccounts() not found");
if (/\b(balance|amount|total|debit|credit|rate)\b/i.test(ba[0]))
  fail("orBuildAccounts body references a figure (balance/amount/total/debit/credit/rate) — the whitelist must exclude them");

// (C) the exact sent messages must be surfaced back to the user.
if (!/UI\.modal\.aiSent/.test(html)) fail("the sent payload must be shown to the user (aiSent preview)");

// Run the REAL scrubDigits from source against adversarial input.
const m = html.match(/function\s+scrubDigits\(s\)\{[\s\S]*?\}/);
if (!m) fail("scrubDigits() not found in index.html");
// eslint-disable-next-line no-new-func
const scrubDigits = new Function(m[0] + "\nreturn scrubDigits;")();
const cases = [
  "paid 500 for rent",
  "bought 2 Subarus for $48,250.75 cash",
  "transfer 1 000 000 to savings",
  "coffee 3.50",
  "invoice #12345 balance 9999",
];
for (const c of cases) {
  const out = scrubDigits(c);
  if (/[0-9]/.test(out)) fail(`scrubDigits left a digit: ${JSON.stringify(c)} -> ${JSON.stringify(out)}`);
}

console.log(`OK: 1 choke-point, digit gate present, letter tokens, preview wired, scrubDigits clean on ${cases.length} cases`);

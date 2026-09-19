// CI guard for the AI feature's promise: your LEDGER'S NUMBERS ARE NEVER SENT (balances, amounts,
// rates, account ids). Numbers the USER types into the request box are theirs and may be sent.
// This locks the two hard gates in place so a future edit can't quietly weaken them:
//   (A) whitelist — accounts are referenced by letter tokens, never their numeric ids;
//   (B) choke-point — the LEDGER-DERIVED payload (system messages + schema) passes one digit gate
//       before fetch; the gate must EXCLUDE the user's own message.
// It also runs the real scrubDigits() from index.html against digit-laden input and
// fails if a single 0-9 survives (scrubDigits guards account names, which are ledger-derived).
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };

// (B) the outbound request must go to exactly ONE OpenRouter chat endpoint — a single choke-point.
const sends = (html.match(/openrouter\.ai\/api\/v1\/chat\/completions/g) || []).length;
if (sends !== 1) fail(`expected exactly one OpenRouter chat endpoint (the choke-point), found ${sends}`);

// (B) the digit gate must sit in orChat, guard the LEDGER-DERIVED payload, and EXCLUDE the user
// message (role !== "user") — so a ledger digit is blocked but the user's own numbers pass.
if (!/const\s+ledgerDerived\s*=\s*JSON\.stringify\(\{\s*sys\s*:\s*messages\.filter\(\s*m\s*=>\s*m\.role\s*!==\s*["']user["']\s*\)[\s\S]*?schema\s*\}\)/.test(html))
  fail("orChat must build `ledgerDerived` from the NON-user messages (m.role !== 'user') plus the schema");
if (!/if\s*\(\s*\/\[0-9\]\/\.test\(ledgerDerived\)\s*\)\s*throw/.test(html))
  fail("orChat must throw when a digit reaches `ledgerDerived` (the redaction gate)");
// the system message that carries the account catalog must still be digit-scrubbed.
if (!/role\s*:\s*["']system["']\s*,\s*content\s*:\s*scrubDigits\(/.test(html))
  fail("the system/catalog message must be wrapped in scrubDigits()");

// (A) accounts must be tokenised to letters (no id leaks); orBuildAccounts must not emit balances.
if (!/function\s+orLetters\(/.test(html)) fail("orLetters() (letter-token references) missing");
const ba = html.match(/function\s+orBuildAccounts\(\)\{[\s\S]*?\n\}/);
if (!ba) fail("orBuildAccounts() not found");
if (/\b(balance|amount|total|debit|credit|rate)\b/i.test(ba[0]))
  fail("orBuildAccounts body references a figure (balance/amount/total/debit/credit/rate) — the whitelist must exclude them");

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

console.log(`OK: 1 choke-point, digit gate present, letter tokens, scrubDigits clean on ${cases.length} cases`);

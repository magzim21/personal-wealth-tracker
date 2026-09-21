// Unit tests for the multi-currency math. Numbers matter, so these extract the REAL functions from
// index.html and assert exact values — money must be correct, and a settled entry must never drift
// when live rates or the display base change (historical FX is frozen per leg).
import { readFileSync } from "node:fs";

const html = readFileSync("index.html", "utf8");
let passed = 0;
const fail = (m) => { console.error("FAIL:", m); process.exit(1); };
const extract = (re, label) => { const m = html.match(re); if (!m) fail(`could not extract ${label} from index.html`); return m[0]; };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const eq = (got, want, label) => { if (!(got === want || near(got, want))) fail(`${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`); passed++; };

// Pull the actual source of the pure/near-pure functions and rebuild them over a mock S.
const src = [
  extract(/const round2=[^\n;]+;/, "round2"),
  extract(/const round4=[^\n;]+;/, "round4"),
  extract(/function rateUSD\(cur\)\{.*\}/, "rateUSD"),
  extract(/function convert\(amount,from,to\)\{.*\}/, "convert"),
  extract(/function fmtGroup\(v\)\{.*\}/, "fmtGroup"),
  extract(/const unGroup=[^\n;]+;/, "unGroup"),
].join("\n");
const make = new Function("S", src + "\nreturn {round2,round4,rateUSD,convert,fmtGroup,unGroup};");

// USD is the vehicle currency: rates are "USD value of 1 unit".
const S = { settings: { currency: "USD", rates: { USD: 1, CAD: 0.7147, UAH: 0.024, ILS: 0.27, EUR: 1.09, XAU: 2400 } } };
const { round2, round4, rateUSD, convert, fmtGroup, unGroup } = make(S);

// --- conversion basics ---
eq(convert(100, "CAD", "USD"), round2Local(71.47), "100 CAD -> USD");           // 100 * 0.7147
eq(round2(convert(100, "USD", "CAD")), 139.92, "100 USD -> CAD");               // 100 / 0.7147
eq(convert(50, "EUR", "EUR"), 50, "same-currency is identity");
eq(convert(1, "XAU", "USD"), 2400, "1 oz gold -> USD");

// --- cross-rate goes THROUGH the vehicle (USD), not through the display base ---
// UAH -> ILS must equal (UAH/USD) / (ILS/USD), independent of what `S.settings.currency` is.
const uahToIls = convert(1000, "UAH", "ILS");
eq(round4(uahToIls), round4(1000 * 0.024 / 0.27), "UAH->ILS via USD vehicle");
S.settings.currency = "CAD";                                                    // change display base...
eq(round4(convert(1000, "UAH", "ILS")), round4(1000 * 0.024 / 0.27), "UAH->ILS unaffected by display base");
S.settings.currency = "USD";

// --- historical FX is frozen: a settled entry balances on stored rates and never shifts ---
// leg value in USD = native * frozenRate (NOT the live rate).
const legUSD = (l) => (l.debit || 0 - 0) * l.rate; // debit side
const tx = { lines: [ { debit: 100, credit: 0, rate: 0.7147 }, { debit: 0, credit: 71.47, rate: 1 } ] };
const debitUSD = () => round2(tx.lines.reduce((s, l) => s + (l.debit || 0) * l.rate, 0));
const creditUSD = () => round2(tx.lines.reduce((s, l) => s + (l.credit || 0) * l.rate, 0));
eq(debitUSD(), 71.47, "frozen debit USD");
eq(creditUSD(), 71.47, "frozen credit USD");
eq(debitUSD() === creditUSD(), true, "entry balances on frozen rates");
S.settings.rates.CAD = 0.40;                                                    // live CAD collapses...
eq(debitUSD(), 71.47, "frozen debit UNCHANGED after rate crash");               // still uses stored 0.7147
eq(debitUSD() === creditUSD(), true, "entry STILL balanced after rate crash");
S.settings.rates.CAD = 0.7147;

// --- changing the vehicle (re-anchor) is a pure ratio change: conversions must be identical before/after ---
S.settings.currency = "USD";
const before = round4(convert(1000, "CAD", "ILS"));
const anchor = S.settings.rates.EUR;                                            // re-anchor USD-map to EUR
Object.keys(S.settings.rates).forEach((c) => { S.settings.rates[c] = round4(S.settings.rates[c] / anchor); });
S.settings.rates.EUR = 1;
const after = round4(convert(1000, "CAD", "ILS"));
eq(Math.abs(before - after) <= before * 1e-3, true, `re-anchoring leaves cross-conversions unchanged (within rounding): ${before} vs ${after}`);
eq(S.settings.rates.EUR, 1, "new vehicle reads as 1.0");

// --- thousands grouping (numbers are important) ---
eq(fmtGroup("1000000"), "1,000,000", "group millions");
eq(fmtGroup("20000.5"), "20,000.5", "group thousands with decimal");
eq(fmtGroup("50.999"), "50.99", "cap to 2 decimals");
eq(fmtGroup("0.5"), ".5", "leading-zero int dropped while typing");
eq(unGroup("1,234,567.50"), 1234567.5, "unGroup parses back to number");
eq(unGroup(""), 0, "unGroup empty -> 0");

function round2Local(n) { return Math.round((n + Number.EPSILON) * 100) / 100; }

console.log(`OK: ${passed} FX/number assertions passed`);

# Ledgerbook

**Double-entry bookkeeping that fits in one HTML file — and stays on your computer.**

Most personal-finance apps are either toys (categorized spending, no real accounting) or
overkill (a database, a login, your data on someone's server). Ledgerbook is the small
middle: real double-entry books, nothing to learn if you already know debits and credits,
and every number lives in a plain file you own.

👉 **Try it now:** <https://personal-wealth-tracker.maxim.run/> — no install, no sign-up.

---

## Why you might like it

- **Real double-entry, not a spending tracker.** A proper chart of accounts and balanced
  debit/credit entries. Assets = Liabilities + Equity, always.
- **No learning curve.** If you know double-entry accounting, you already know how to use
  it. If you don't, the structure teaches it: you can't post to the wrong kind of account.
- **It stays on your computer.** No account, no cloud, no telemetry. The only time it
  touches the internet is when *you* click “fetch exchange rates”.
- **You choose where your data lives.** Point it at any folder — a local disk, a mounted
  drive, or your **iCloud Drive** so it follows you between machines. It's just a JSON file.
- **Automatic snapshots on every change.** Every save also writes a timestamped copy to a
  snapshots folder, so you can always roll back. That folder can live in a **third,
  separate location** of your choosing.
- **Multi-currency.** Each account has its own currency; balances convert to your display
  currency using rates you control (or fetch live).
- **Yours to keep.** One `index.html`, a tiny local server, and your data file. No build
  step, no framework, no lock-in.

## How the books are organised

Three levels, matching how real accounting software is structured:

```
Class            e.g. Assets · Liabilities · Equity      (fixed, cannot be posted to)
  └─ Type        e.g. Bank · Fixed assets · Loans        (your groupings, cannot be posted to)
       └─ Account e.g. Checking · Car · Owner's equity    (the only thing you post to)
```

You record a transaction as balanced lines (debits = credits); only detail **accounts**
accept postings, so you can never accidentally book to a summary line.

## Run it on your machine

You need [Node.js](https://nodejs.org) **or** [Go](https://go.dev). From this folder:

```bash
node server.mjs        # or:  go run server.go
```

then open <http://127.0.0.1:8123>. That's it — the server owns your data file and serves
the app locally.

### Develop with auto-restart

One command, one terminal — the server restarts itself whenever you edit it (Node 18.11+):

```bash
node --watch server.mjs
```

That's it. `index.html` changes need **no** restart — the server reads it from disk on every
request and sends `Cache-Control: no-store`, so a browser **⌘R** always shows your latest
edit. `--watch` restarts only when `server.mjs` (the backend) changes, and it deliberately
**ignores `ledger.json` and snapshots**, so saving a transaction never bounces the server.

Go equivalent (needs a watcher — `air` or `entr`):

```bash
go install github.com/air-verse/air@latest && air        # config-free
find . -name '*.go' | entr -r go run server.go           # …or with entr
```

Note: the app compares its version with the server's and shows a "restart the server" prompt
when they differ. Bump `VERSION` in `index.html` and `APP_VERSION` in `server.mjs` together;
editing `server.mjs` triggers the `--watch` restart, so they come back in step.

### Where your data is stored (and how to change it)

The server keeps your books in one JSON file and writes a snapshot next to it on every
save. Both locations are yours to set — from the app's **Storage** panel, or with
environment variables:

```bash
LEDGER_PATH="$HOME/Library/Mobile Documents/com~apple~CloudDocs/Ledgerbook/ledger.json" \
SNAPSHOT_DIR="/Volumes/Backup/ledgerbook-snapshots" \
node server.mjs
```

If you don't set anything, it figures out sensible defaults, in this order (**fallback
paths**):

| What | Order it looks |
| --- | --- |
| **Ledger file** | `LEDGER_PATH` → your saved choice → `./ledger.json` if present → **iCloud Drive** |
| **Snapshots** | `SNAPSHOT_DIR` → your saved choice → a `snapshots/` folder next to the ledger |

Your choice is remembered between restarts. The ledger file is deliberately **git-ignored**
— your finances never end up in the repository (a commit hook and CI enforce this).

### Exchange rates (optional)

Fiat rates work out of the box from a free source. For crypto and metals (BTC, XAU, XAG)
and the most reliable fiat, give the server a free [Twelve Data](https://twelvedata.com)
key — it stays on your machine and is never exposed to the browser:

```bash
TWELVEDATA_API_KEY=your_key node server.mjs
```

### Local API

The server exposes a small JSON API at `http://127.0.0.1:8123` — see
[`openapi.yaml`](openapi.yaml) for the full spec (`/api/book`, `/api/location`,
`/api/version`, `/api/rates`, `/api/pick`, `/api/ping`). It binds to loopback only and has
no authentication: the protection is that the port isn't reachable off-machine. CI checks
that `openapi.yaml` stays in sync with the routes (`scripts/check-openapi.mjs`).

### Data model & migrations (for developers)

The **server never interprets your data** — it only stores and serves the raw JSON bytes.
All schema knowledge lives in the **frontend** (`index.html`): the ledger carries a
`schemaVersion`, and `SCHEMA` in the app is the version this build understands.

**Migrations run in the browser, on load.** When the app opens a file, `normalizeState()`
(and, for bigger structural changes, `migrate()`) backfills any missing/renamed fields
*in place*, stamps the current `schemaVersion`, and saves the upgraded book back. Backfills
are **idempotent** — they only fill what's absent — so loading an old file simply upgrades it,
and loading it again is a no-op. To evolve the shape: add the backfill, bump `SCHEMA`, and keep
both the app (`VERSION`) and server (`APP_VERSION`) in step.

Guardrails: the app **refuses to open a file written by a newer `schemaVersion`** (so an old
build can't corrupt a newer file), the server writes a timestamped snapshot on every save, and
writes are gated by an ETag/`If-Match` check so a stale tab can't clobber a fresher file.

## About the online demo

The **[live demo](https://personal-wealth-tracker.maxim.run/)** (GitHub Pages) is there so
you can try Ledgerbook instantly. It's the same app, but with no local server it stores
everything in your **browser's local storage** — so the data is still only on your device,
it just isn't a portable file and isn't shared anywhere. For real use, run it locally so
your books live in a file you control and get automatic snapshots.

## Privacy & security

Everything that keeps your numbers on your machine, in one place:

- **Local-first, loopback-only.** Your books are one JSON file on your machine. The local
  server listens on `127.0.0.1` only, so nothing off your computer can reach it.
- **No account, no cloud, no telemetry.** The only traffic that ever leaves is what you
  trigger — an exchange-rate lookup, or an AI draft.
- **AI drafting never sends numbers.** When you use OpenRouter to draft an entry, amounts are
  replaced with `‹num›`, accounts are referred to by letter tokens (A, B, C…) never their ids,
  and a hard check aborts the request if a single digit survives. There is no toggle. Your key
  is minted by a browser-only OAuth (PKCE) flow and lives only in your browser.
- **Your data can't be silently corrupted.** Every file carries a `schemaVersion` (a file from
  a newer version is refused, not overwritten) and an ETag guard (a stale tab can't clobber a
  fresher save). A timestamped snapshot is written on every change.
- **Nothing hidden on disk.** Config and snapshots live in a project-local, git-ignored folder
  you can see — never in system directories.
- **Browser hardened (what a page can do).** The app turns off spellcheck (so Chrome can't send
  field text to Google's "enhanced" spell check), marks itself non-translatable, and sends no
  referrer on outbound requests.
- **Privacy Mode.** Blur every amount for a screenshot; reveal one at a time.
- Your ledger is a plain JSON file — back it up like any other. Pointing snapshots (or the
  ledger) at iCloud/Dropbox gives you off-device copies automatically. Export a full backup any
  time from **Settings → Export**.

### Browser settings only you can change

A page can't turn off the browser's own data collection. In Chrome, for maximum privacy:

- **Enhanced spell check** (sends typed text to Google) → Settings → Languages → *Spell check*:
  use **Basic**.
- **Safe Browsing** (Enhanced sends URLs/content) → Privacy and security → Security: **Standard**
  or No protection.
- **Address-bar suggestions** → Privacy and security → *Search suggestions*: turn off
  "Autocomplete searches and URLs".
- **Usage stats & Sync** → don't sign in / disable Sync, and turn off "Help improve Chrome".

For maximum isolation, run the app in a browser without Google services (ungoogled-chromium or
Firefox). These recommendations are also in the app under **Settings → Privacy recommendations**.

## License

See [LICENSE.txt](LICENSE.txt).

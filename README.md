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

## About the online demo

The **[live demo](https://personal-wealth-tracker.maxim.run/)** (GitHub Pages) is there so
you can try Ledgerbook instantly. It's the same app, but with no local server it stores
everything in your **browser's local storage** — so the data is still only on your device,
it just isn't a portable file and isn't shared anywhere. For real use, run it locally so
your books live in a file you control and get automatic snapshots.

## Privacy & keeping your data safe

- Nothing leaves your machine except exchange-rate lookups you trigger.
- Your ledger is a plain JSON file — back it up like any other file. Snapshots give you
  point-in-time history for free; pointing them (or the ledger) at iCloud/Dropbox gives you
  off-device copies automatically.
- Export a full backup any time from **Backup / restore**.

## License

See [LICENSE.txt](LICENSE.txt).

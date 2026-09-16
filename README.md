# Personal Wealth Tracker

A private, double-entry bookkeeping app. Single self-contained `index.html` — no build step, no framework.

- **Chart of accounts** organised as **Class → Type → Account** (Assets / Liabilities / Equity → account groups → postable detail accounts). Only detail accounts are postable.
- **Ledger** of balanced debit/credit transactions, multi-currency, with per-entry comments.
- **Multi-currency** with a rates table; live rates when online.
- **Local & private** — data never leaves your machine.

## Two ways to run

The app talks to one storage interface with two adapters, chosen once at startup
(ports & adapters / hexagonal architecture):

### 1. Just open it (browser storage)
Open `index.html` in a browser. Data is saved in that browser's local storage.

### 2. Local file as the database (offline desktop)
Run a tiny local server so the app persists to a plain `ledger.json` file on disk:

    go run server.go
    # or:  node server.mjs

then open http://127.0.0.1:8123 . The app auto-detects the server and stores everything in `ledger.json` next to it. The server binds to `127.0.0.1` only.

## Exchange rates

Click **Exchange rates → Fetch live rates**. With the local server, rates are proxied server-side.
For crypto (BTC) and metals (XAU/XAG) — and the most reliable fiat — provide a free
[Twelve Data](https://twelvedata.com) API key:

    TWELVEDATA_API_KEY=your_key go run server.go
    # or:  TWELVEDATA_API_KEY=your_key node server.mjs

Without a key it still fetches fiat from a free, no-key source. The key stays on your machine (used only by the local server, never sent to the browser).

## Files

- `index.html` — the whole app.
- `server.go` / `server.mjs` — the optional local server (file storage + rate proxy). Pick either.

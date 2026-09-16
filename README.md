# Personal Wealth Tracker

A private, double-entry bookkeeping app. Single self-contained `index.html` — no build step, no framework.

- **Chart of accounts** organised as **Class → Type → Account** (only detail accounts are postable).
- **Ledger** of balanced debit/credit transactions, multi-currency, with per-entry comments.
- **Local & private** — data never leaves your device.

## Run it

Open `index.html` in a browser (data in browser storage), **or** run the local server so it persists to a plain `ledger.json` file:

    go run server.go        # or:  node server.mjs

then open http://127.0.0.1:8123 (binds to localhost only).

## Exchange rates

`Exchange rates → Fetch live rates`. For crypto (BTC) and metals (XAU/XAG), give the local server a free [Twelve Data](https://twelvedata.com) key:

    TWELVEDATA_API_KEY=your_key go run server.go

Without a key it still fetches fiat from a free, no-key source. The key stays on your machine.

## Data safety

Your finances live only in a local, git-ignored `ledger.json` (or your browser). Guardrails keep them out of git: `.gitignore`, a `.githooks/pre-commit` hook (run `sh setup.sh` once to enable), and a CI check.

> Note: `index.html`, `README.md` and `.github/workflows/main.yaml` in this repo are managed by Terraform and may be overwritten by it — see the pinned issue / your IaC before relying on the repo copy.

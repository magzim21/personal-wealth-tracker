#!/usr/bin/env bash
# Guardrail (CI mirror of .githooks/pre-commit): fail if personal-finance
# data is tracked in the repo — by filename or by ledger-like JSON content.
set -euo pipefail

if git ls-files | grep -Ei '(^|/)(ledger\.json|.*\.ledger\.json|ledgerbook-.*\.(json|csv)|.*wealth.*\.json|.*finances.*\.json)$'; then
  echo "::error::A personal-finance data file is tracked in the repository."
  exit 1
fi

for f in $(git ls-files '*.json'); do
  if grep -q '"accounts"' "$f" && grep -q '"transactions"' "$f" && grep -Eq '"typeId"|"debit"|"credit"' "$f"; then
    echo "::error file=$f::File looks like committed ledger data."
    exit 1
  fi
done

echo "OK — no personal financial data found."

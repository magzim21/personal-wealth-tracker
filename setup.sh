#!/bin/sh
# Enable the guardrail git hooks (blocks committing personal financial data).
git config core.hooksPath .githooks
echo "Guardrail hooks enabled (core.hooksPath = .githooks)."

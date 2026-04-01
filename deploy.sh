#!/usr/bin/env bash
# DLM Digital — One-Shot Deployment Script
# Run this AFTER the GitHub repo is set up (DLM-66 must be done).
#
# Usage:
#   ./deploy.sh <git-remote-url>
#   Example: ./deploy.sh git@github.com:USERNAME/dlm-digital-crm.git

set -euo pipefail

REPO_URL="${1:-}"

if [[ -z "$REPO_URL" ]]; then
  echo "Usage: ./deploy.sh <git-remote-ssh-url>"
  echo "Example: ./deploy.sh git@github.com:USERNAME/dlm-digital-crm.git"
  exit 1
fi

echo "=== DLM Digital — Deployment ==="
echo "Remote: $REPO_URL"
echo

# ── 1. Verify demos are generated ────────────────────────────────────────────
DEMO_COUNT=$(find demo-generator/output -mindepth 1 -maxdepth 1 -type d | wc -l | tr -d ' ')
echo "✅ $DEMO_COUNT demos found in demo-generator/output/"

if [[ "$DEMO_COUNT" -lt 90 ]]; then
  echo "❌ Expected ~100 demos, found $DEMO_COUNT. Run: node demo-generator/scripts/generate.js"
  exit 1
fi

# ── 2. Stage + commit everything ─────────────────────────────────────────────
git add -A
if git diff --cached --quiet; then
  echo "ℹ️  Nothing to commit — already up to date"
else
  git commit -m "chore: deploy 100 static demos + full sales infrastructure

Co-Authored-By: Paperclip <noreply@paperclip.ing>"
  echo "✅ Committed"
fi

# ── 3. Set remote + push ──────────────────────────────────────────────────────
if git remote get-url origin &>/dev/null; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

git push -u origin main
echo "✅ Pushed to GitHub"

# ── 4. Next steps ─────────────────────────────────────────────────────────────
echo
echo "=== Coolify Setup (one-time, in Coolify UI) ==="
echo "1. New Resource → Docker Compose"
echo "2. Source: GitHub → select this repo"
echo "3. Compose file path: sales-infra/docker-compose.yml"
echo "4. Set env vars from sales-infra/.env.example"
echo "5. Deploy → check demo.dlm-digital.ch"
echo
echo "=== Done ==="

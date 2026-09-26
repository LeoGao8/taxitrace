#!/bin/sh
# Publish your changes. Safe to run any time, as often as you like.
#
#   ./update.sh
#
# Airport data under data/ is never sent to GitHub: it is only a cache, and the site
# rebuilds it from OpenStreetMap by itself. That is why this can't hit a merge conflict.
#
# If something goes wrong it stops and tells you what to ask Claude. It never throws
# away your work.

set -eu

cd "$(dirname "$0")"

die() {
  echo
  echo "=============================================="
  echo " STOPPED: $1"
  echo
  echo " Your files are safe and nothing was lost."
  echo " Ask Claude: \"update.sh said: $2\""
  echo "=============================================="
  exit 1
}

[ -d .git ] || die "this folder is not a git repo" "not a git repo"
git remote get-url origin >/dev/null 2>&1 || die "there is no 'origin' remote" "no origin remote"

# The cache must stay out of git. Harmless to re-check every run.
grep -qx 'data/' .gitignore 2>/dev/null || printf 'data/\n' >> .gitignore
if git ls-files --error-unmatch data >/dev/null 2>&1; then
  echo "Taking data/ out of git (your local copy stays)..."
  git rm -r -q --cached data
fi

git add -A
if git diff --cached --quiet; then
  echo "Nothing has changed since last time."
else
  git commit -q -m "update $(date '+%Y-%m-%d %H:%M')" || die "the commit failed" "the commit failed"
  echo "Saved your changes."
fi

BRANCH=$(git rev-parse --abbrev-ref HEAD)

# Pick up anything the robot or another machine pushed, then publish.
git fetch -q origin || die "could not reach GitHub (check your internet)" "could not reach GitHub"
if git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then
  git rebase -q "origin/$BRANCH" || {
    git rebase --abort 2>/dev/null || true
    die "your changes clash with what is on GitHub" "the rebase clashed and aborted"
  }
fi

echo "Sending to GitHub..."
git push -q -u origin "$BRANCH" || die "the push was rejected" "the push was rejected"

echo
echo "=============================================="
echo " Done. Cloudflare is rebuilding the site now;"
echo " it goes live in a minute or two."
echo "=============================================="

#!/bin/sh
# Publish whatever is on this machine. Safe to run any time, as often as you like.
#
# Airport data under data/ is deliberately NOT committed: it is a cache the Worker
# refetches from OpenStreetMap by itself, so keeping it out of git means two machines
# can never disagree about it and you can never get a merge conflict.
#
# If anything goes wrong this stops and tells you to ask Claude. It never leaves the
# repo half-finished, and it never throws away your work.

set -eu

cd "$(dirname "$0")"

die() {
  echo
  echo "=============================================="
  echo " STOPPED: $1"
  echo
  echo " Nothing was broken and nothing was lost."
  echo " Ask Claude: \"update.sh said: $2\""
  echo "=============================================="
  exit 1
}

[ -d .git ] || die "this folder is not a git repo" "not a git repo"
git rev-parse --verify HEAD >/dev/null 2>&1 || die "this repo has no commits yet" "no commits yet"

# --- keep data/ out of git, so it can never conflict -------------------------
grep -qx 'data/' .gitignore 2>/dev/null || printf 'data/\n' >> .gitignore

# Untracks it without deleting your local files (-r --cached). Only does anything
# the first time, or if data/ ever got committed again by accident.
if git ls-files --error-unmatch data >/dev/null 2>&1; then
  echo "Removing data/ from git (your local copy stays put)..."
  git rm -r -q --cached data
fi

# --- commit local work ------------------------------------------------------
git add -A
if git diff --cached --quiet; then
  echo "No local changes to commit."
else
  git commit -q -m "update $(date '+%Y-%m-%d %H:%M')" || die "the commit failed" "the commit failed"
  echo "Committed your changes."
fi

# --- catch up with the remote, then publish ---------------------------------
BRANCH=$(git rev-parse --abbrev-ref HEAD)
[ "$BRANCH" = "HEAD" ] && die "you are not on a branch" "not on a branch"

if git remote get-url origin >/dev/null 2>&1; then
  echo "Fetching origin..."
  git fetch -q origin || die "could not reach GitHub (check your internet)" "could not reach GitHub"

  # Only rebase if the remote branch actually exists (first push has no upstream).
  if git rev-parse --verify --quiet "origin/$BRANCH" >/dev/null; then
    echo "Replaying your commits on top of origin/$BRANCH..."
    if ! git rebase -q "origin/$BRANCH"; then
      git rebase --abort 2>/dev/null || true
      die "your changes and GitHub's have collided and I could not sort it out automatically" \
          "the rebase collided and it aborted"
    fi
  fi

  echo "Pushing to origin/$BRANCH..."
  git push -q -u origin "$BRANCH" || die "the push was rejected" "the push was rejected"
else
  die "there is no 'origin' remote set up" "no origin remote"
fi

echo
echo "=============================================="
echo " Done. Pushed to origin/$BRANCH."
echo " Cloudflare rebuilds and redeploys from this"
echo " push on its own; give it a minute or two."
echo "=============================================="

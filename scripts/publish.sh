#!/usr/bin/env bash
#
# Add one curated commit to the public branch, matching main's tree.
#
# Two histories, deliberately:
#
#   main    private. Candid commit messages, working notes, the legal
#           reasoning in docs/. Never pushed anywhere public.
#   public  one curated commit per release, written for strangers. It
#           accumulates rather than being re-squashed, because the privacy
#           and terms pages promise that changes to them are inspectable in
#           that history.
#
# This never checks out a branch: switching branches with files that exist
# on one side and not the other can leave the working tree stranded
# mid-swap. `git commit-tree` builds the commit directly from main's tree
# object instead, so the working tree is never touched and there is no state
# to get stuck in.
#
# It does not push. Publishing to a public repository should not happen as a
# side effect of a build step.
set -euo pipefail
cd "$(dirname "$0")/.."

PUBLIC_REMOTE="https://github.com/besethda/amply.stream.git"
SOURCE="main"
BRANCH="public"

msg="${1:-}"
[ -z "$msg" ] && { echo "usage: npm run publish -- \"commit message\""; exit 2; }

current=$(git branch --show-current)
[ "$current" = "$SOURCE" ] || { echo "refusing: on '$current', expected '$SOURCE'"; exit 1; }

if ! git diff --quiet || ! git diff --cached --quiet; then
  echo "refusing: uncommitted changes. Commit to $SOURCE first."
  exit 1
fi

# Stale build outputs would ship silently — several files in site/ are
# compiled from elsewhere in the repo and look hand-written.
echo "building…"
npm run build --silent >/dev/null
if ! git diff --quiet; then
  echo "refusing: the build changed tracked files. Commit them to $SOURCE first:"
  git diff --name-only | sed 's/^/  /'
  exit 1
fi

# Private paths are tracked in main but left out of the public tree: the
# working notes and legal reasoning in docs/, and the original logo artwork.
# Built in a throwaway index, so neither the working tree nor main's index is
# touched.
PRIVATE=(docs amply-source.svg)
index=$(mktemp)
trap 'rm -f "$index"' EXIT
GIT_INDEX_FILE="$index" git read-tree "$SOURCE"
GIT_INDEX_FILE="$index" git rm -r --cached --quiet --ignore-unmatch -- "${PRIVATE[@]}"
tree=$(GIT_INDEX_FILE="$index" git write-tree)

# Belt and braces. These must never reach a public tree, whatever .gitignore
# happens to say today.
leaked=$(git ls-tree -r --name-only "$tree" | grep -E '^(docs/|\.env$|\.env\.[^e]|.*wrangler\.local)' || true)
if [ -n "$leaked" ]; then
  echo "REFUSING — these must not be published:"
  echo "$leaked" | sed 's/^/  /'
  exit 1
fi

if [ "$tree" = "$(git rev-parse "$BRANCH^{tree}")" ]; then
  echo "nothing to publish — $BRANCH already matches $SOURCE"
  exit 0
fi

echo
echo "changes to publish:"
git diff --stat "$BRANCH" "$tree" -- . | sed 's/^/  /'
echo

commit=$(git commit-tree "$tree" -p "$BRANCH" -m "$msg")
git update-ref "refs/heads/$BRANCH" "$commit"

echo "committed to $BRANCH: $(git log --format='%h %s' -1 "$BRANCH")"
echo
echo "to publish, run:"
echo "  git push $PUBLIC_REMOTE $BRANCH:main"

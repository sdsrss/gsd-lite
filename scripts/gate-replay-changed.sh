#!/usr/bin/env bash
#
# Replay every test file a commit range touched against the tree it was written
# to change. This is scripts/gate-replay.js driven over a range instead of over
# a path the author picked, so the question gets asked whether or not anyone
# remembers to ask it.
#
# ONE FILE PER INVOCATION, deliberately. gate-replay.js runs every path you hand
# it in a single `node --test` and reports one verdict over the lot, so a vacuous
# file sharing a run with a discriminative one lands in `fail > 0` and comes back
# DISCRIMINATIVE. That is the exact shape this repo built the script to stop
# believing. Per file, each verdict is about the file it names.
#
# What each verdict does here:
#
#   DISCRIMINATIVE (0)  the file was red on the base tree. Passes.
#   VACUOUS        (1)  every test in it passed on the base tree. FAILS: the
#                       file encodes nothing the change fixed.
#   INCONCLUSIVE   (2)  nothing was evaluated — the file could not load against
#                       the base tree (typically a helper the same commit added),
#                       or it declared no tests. Reported, does NOT fail. A test
#                       that imports something new is ordinary work, and a check
#                       that fires on ordinary work is one people learn to click
#                       through.
#
# Usage: scripts/gate-replay-changed.sh <base-rev> [at-rev]

set -uo pipefail # NOT -e: a non-zero verdict is this script's input, not a crash.

BASE="${1:-}"
AT="${2:-HEAD}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ZERO='0000000000000000000000000000000000000000'

# Announce loudly rather than exiting 0 in silence. A gate that did not run and
# says nothing is indistinguishable in a job list from a gate that passed, which
# is the failure mode this whole script exists to argue against.
not_run() {
  echo "GATE NOT RUN — $1"
  [ -n "${GITHUB_STEP_SUMMARY:-}" ] && echo "**gate-replay did not run** — $1" >>"$GITHUB_STEP_SUMMARY"
  exit 0
}

[ -n "$BASE" ] || not_run "no base revision given (usage: $0 <base-rev> [at-rev])"
[ "$BASE" != "$ZERO" ] || not_run "the push created this ref, so there is no previous tree to compare against"
git -C "$ROOT" rev-parse --verify --quiet "$BASE^{commit}" >/dev/null \
  || not_run "base revision '$BASE' is not in this clone (a shallow fetch cannot answer this)"
git -C "$ROOT" rev-parse --verify --quiet "$AT^{commit}" >/dev/null \
  || not_run "at revision '$AT' is not in this clone"

if [ "$(git -C "$ROOT" rev-parse "$BASE")" = "$(git -C "$ROOT" rev-parse "$AT")" ]; then
  not_run "base and at are the same commit; a file replayed on its own tree passes by construction"
fi

# --diff-filter=AM: a test file this range DELETED does not exist at `at`, and
# gate-replay.js refuses a path it cannot read there. Renames arrive as A.
mapfile -t FILES < <(
  git -C "$ROOT" diff --name-only --diff-filter=AM "$BASE" "$AT" -- tests \
    | grep -E '\.test\.js$'
)

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "no test files added or modified between $(git -C "$ROOT" rev-parse --short "$BASE") and $(git -C "$ROOT" rev-parse --short "$AT") — nothing to replay"
  exit 0
fi

vacuous=()
inconclusive=()
discriminative=()

for file in "${FILES[@]}"; do
  echo "::group::gate-replay $file"
  node "$ROOT/scripts/gate-replay.js" --base "$BASE" --at "$AT" "$file"
  case $? in
    0) discriminative+=("$file") ;;
    1) vacuous+=("$file") ;;
    *) inconclusive+=("$file") ;;
  esac
  echo "::endgroup::"
done

echo
echo "── gate-replay: ${#FILES[@]} changed test file(s) ──"
for f in "${discriminative[@]+"${discriminative[@]}"}"; do echo "  DISCRIMINATIVE  $f"; done
for f in "${inconclusive[@]+"${inconclusive[@]}"}"; do echo "  INCONCLUSIVE    $f"; done
for f in "${vacuous[@]+"${vacuous[@]}"}"; do echo "  VACUOUS         $f"; done

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### gate-replay"
    echo
    echo "Replayed against \`$(git -C "$ROOT" rev-parse --short "$BASE")\`."
    echo
    for f in "${discriminative[@]+"${discriminative[@]}"}"; do echo "- ✅ DISCRIMINATIVE \`$f\`"; done
    for f in "${inconclusive[@]+"${inconclusive[@]}"}"; do echo "- ⚠️ INCONCLUSIVE \`$f\` — nothing was evaluated; read the log"; done
    for f in "${vacuous[@]+"${vacuous[@]}"}"; do echo "- ❌ VACUOUS \`$f\` — green on the base tree"; done
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [ "${#vacuous[@]}" -gt 0 ]; then
  echo
  echo "FAILED — ${#vacuous[@]} test file(s) passed in full on the tree they were written to change."
  echo "Assert the property the commit fixed, not a token of it."
  exit 1
fi

exit 0

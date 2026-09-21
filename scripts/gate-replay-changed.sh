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
#   CRASHED        (other) gate-replay.js did not finish — no verdict was
#                       reached. FAILS: a checker that crashed has cleared nothing.
#
# WHAT THIS DOES NOT CATCH, stated because the alternative is implying otherwise:
# the verdict is per FILE, so one vacuous `it()` hides behind a real one in the
# same file — demonstrated by appending an `includes('e')` assertion to a file
# with four genuinely-red tests and getting DISCRIMINATIVE and a green job. That
# is the same defect class one level down from the one this script fixes, and
# closing it needs per-test replay (`--test-name-pattern`), which is a different
# build. Do not read a green job as "no vacuous assertion was added".
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

# D is excluded because a test file this range DELETED does not exist at `at`,
# and gate-replay.js refuses a path it cannot read there.
#
# R is included, and the first version of this line said "Renames arrive as A".
# That is false. Git's default rename detection reports `R097 old new`, and
# `--diff-filter=AM` returns NOTHING for it — so renaming a test file while
# editing it skipped the gate entirely and the job went green. Found by the
# pre-tag reviewer and reproduced against real git. `--name-only` yields the new
# path for an R, which is the one that exists at `at`.
#
# The subshell's status is captured rather than assumed: `mapfile < <(...)` never
# inspects it and `pipefail` does not cross process substitution, so a failing
# `git diff` became "nothing to replay" and a green job.
FILE_LIST_ALL=$(git -C "$ROOT" diff --name-only --diff-filter=AMR "$BASE" "$AT") \
  || not_run "git diff failed for $BASE..$AT — the file list is unknown, not empty"
FILE_LIST=$(printf '%s\n' "$FILE_LIST_ALL" | grep -E '^tests/' || true)
mapfile -t FILES < <(printf '%s\n' "$FILE_LIST" | grep -E '\.test\.js$')

# A range that changes no source file cannot have its tests red on the base tree,
# because the base tree IS the tree those tests describe. VACUOUS there is not a
# finding, it is the question being unanswerable — which is what INCONCLUSIVE
# means, so that is what it gets.
#
# Measured by the pre-tag reviewer before this existed: ~9% of this repo's
# test-touching commits are test-only, and of six sampled, four came back VACUOUS
# and two INCONCLUSIVE — none passed. Shipping that would have put a job in the
# required-checks list that fails on ordinary work, which this script's own
# header argues against; the only available remedy would have been to bypass it,
# and a gate people bypass is worse than no gate.
#
# NOT-SOURCE is an explicit list, not "anything that looks like docs". The first
# version excluded every `*.md`, which classified 71271dd — the documented
# vacuous commit this whole script exists for — as test-only, because it changed
# `agents/executor.md` and `agents/reviewer.md` and nothing else. Those are
# SHIPPED PROMPT TEMPLATES: they steer agent behaviour at runtime, a test over
# them is a test over behaviour, and the exemption would have neutered the one
# case the gate was built to catch. Caught by running the rule against 71271dd
# before trusting it.
#
# So: an unknown path counts as source and the gate fires. Only these are not.
NOT_SOURCE='^tests/|^tasks/|^docs/|^CHANGELOG\.md$|^README\.md$|^LICENSE$'
SOURCE_TOUCHED=$(
  printf '%s\n' "$FILE_LIST_ALL" | grep -vE "$NOT_SOURCE" | grep -c . || true
)
TEST_ONLY=0
[ "$SOURCE_TOUCHED" -eq 0 ] && TEST_ONLY=1

if [ "${#FILES[@]}" -eq 0 ]; then
  echo "no test files added or modified between $(git -C "$ROOT" rev-parse --short "$BASE") and $(git -C "$ROOT" rev-parse --short "$AT") — nothing to replay"
  exit 0
fi

vacuous=()
inconclusive=()
discriminative=()
crashed=()

for file in "${FILES[@]}"; do
  echo "::group::gate-replay $file"
  node "$ROOT/scripts/gate-replay.js" --base "$BASE" --at "$AT" "$file"
  code=$?
  # `*)` used to mean INCONCLUSIVE, which silently absorbed every code the
  # script never emits: a `node --test` killed by the OOM killer exits 137 and
  # the job passed green, reported as "nothing was evaluated". That is a verdict
  # this run never reached. Only 2 is INCONCLUSIVE; an unknown code is a failure
  # of the gate itself and has to be loud, because the alternative is a checker
  # that reports a clean result when it crashed.
  case $code in
    0) discriminative+=("$file") ;;
    1) vacuous+=("$file") ;;
    2) inconclusive+=("$file") ;;
    *) crashed+=("$file (exit $code)") ;;
  esac
  echo "::endgroup::"
done

echo
echo "── gate-replay: ${#FILES[@]} changed test file(s) ──"
for f in "${discriminative[@]+"${discriminative[@]}"}"; do echo "  DISCRIMINATIVE  $f"; done
for f in "${inconclusive[@]+"${inconclusive[@]}"}"; do echo "  INCONCLUSIVE    $f"; done
for f in "${crashed[@]+"${crashed[@]}"}"; do echo "  CRASHED         $f"; done
for f in "${vacuous[@]+"${vacuous[@]}"}"; do echo "  VACUOUS         $f"; done

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
  {
    echo "### gate-replay"
    echo
    echo "Replayed against \`$(git -C "$ROOT" rev-parse --short "$BASE")\`."
    echo
    for f in "${discriminative[@]+"${discriminative[@]}"}"; do echo "- ✅ DISCRIMINATIVE \`$f\`"; done
    for f in "${inconclusive[@]+"${inconclusive[@]}"}"; do echo "- ⚠️ INCONCLUSIVE \`$f\` — nothing was evaluated; read the log"; done
    for f in "${crashed[@]+"${crashed[@]}"}"; do echo "- ❌ CRASHED \`$f\` — no verdict reached"; done
    for f in "${vacuous[@]+"${vacuous[@]}"}"; do echo "- ❌ VACUOUS \`$f\` — green on the base tree"; done
  } >>"$GITHUB_STEP_SUMMARY"
fi

if [ "${#crashed[@]}" -gt 0 ]; then
  echo
  echo "FAILED — gate-replay.js did not finish for ${#crashed[@]} file(s):"
  for f in "${crashed[@]}"; do echo "  $f"; done
  echo "No verdict was reached. A checker that crashed has not cleared anything."
  exit 1
fi

if [ "${#vacuous[@]}" -gt 0 ] && [ "$TEST_ONLY" = "1" ]; then
  echo
  echo "TEST-ONLY RANGE — ${#vacuous[@]} file(s) came back VACUOUS and that is not a finding."
  echo "This range changes no source file, so its tests describe the base tree and pass on it"
  echo "by construction. The question this job asks cannot be answered here; it is not being"
  echo "answered in the affirmative."
  exit 0
fi

if [ "${#vacuous[@]}" -gt 0 ]; then
  echo
  echo "FAILED — ${#vacuous[@]} test file(s) passed in full on the tree they were written to change."
  echo "Assert the property the commit fixed, not a token of it."
  exit 1
fi

exit 0

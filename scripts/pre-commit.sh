#!/bin/bash
# GSD-Lite pre-commit hook
# Checks: version consistency across package.json / plugin.json / marketplace.json,
# lint, then one test run that both gates the commit and syncs CLAUDE.md's count.

set -e

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# ── 1. Version consistency across 4 locations ──────────────
# Triggered when package.json OR version-bearing files are staged
if git diff --cached --name-only | grep -qE '^(package\.json|\.claude-plugin/|CLAUDE\.md)'; then
  PKG_VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")

  PLUGIN_VER=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8')).version)}catch{console.log('n/a')}")
  MKT_VER=$(node -e "try{const m=JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json','utf8'));console.log(m.plugins?.[0]?.version||'n/a')}catch{console.log('n/a')}")

  MISMATCH=0
  [ "$PLUGIN_VER" != "n/a" ] && [ "$PLUGIN_VER" != "$PKG_VER" ] && MISMATCH=1
  [ "$MKT_VER" != "n/a" ] && [ "$MKT_VER" != "$PKG_VER" ] && MISMATCH=1

  if [ "$MISMATCH" -eq 1 ]; then
    echo -e "${YELLOW}Version mismatch detected: pkg=$PKG_VER plugin=$PLUGIN_VER mkt=$MKT_VER${NC}"
    echo -e "${GREEN}Auto-syncing versions...${NC}"
    node scripts/sync-versions.js 2>/dev/null || true
    git add .claude-plugin/plugin.json .claude-plugin/marketplace.json 2>/dev/null || true
    echo -e "${GREEN}Versions synced to $PKG_VER${NC}"
  fi
fi

# ── 2. Lint check on staged src/tests/hooks files ─────────
STAGED_SRC=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^(src|tests|hooks)/' || true)
if [ -n "$STAGED_SRC" ]; then
  echo -e "${GREEN}Running lint...${NC}"
  npx biome check src/ tests/ hooks/ --no-errors-on-unmatched 2>/dev/null || {
    echo -e "${RED}Lint failed. Run 'npm run lint:fix' to auto-fix.${NC}"
    exit 1
  }
fi

# ── 3. One test run serving both the red/green gate and the CLAUDE.md count ──
# These used to be two sections that each ran the full suite. The first parsed
# `# tests N` — the TAP reporter's form — while `npm test` here is plain
# `node --test`, whose default reporter prints `ℹ tests N`. The parse therefore
# matched nothing on every Node this repo supports, and said so silently: "found
# no count" takes the same branch as "count already correct".
#
# The empty value was load-bearing rather than merely useless. The test section
# below it skipped itself when the count was non-empty, on the theory that the
# sync above had already run the suite — so an always-empty count meant every
# commit touching tests/ ran the full suite twice and synced nothing.
#
# One run now feeds both. tests/repo-gates.test.js pins the pattern against both
# reporter forms so a future reporter change fails loudly here instead.
STAGED_TESTS=$(git diff --cached --name-only --diff-filter=ACMRD | grep -E '^tests/' || true)
STAGED_CLAUDE=$(git diff --cached --name-only | grep -q '^CLAUDE.md$' && echo "yes" || true)
STAGED_CODE=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^(src|tests)/' || true)

if [ -n "$STAGED_TESTS" ] || [ -n "$STAGED_CLAUDE" ] || [ -n "$STAGED_CODE" ]; then
  echo -e "${GREEN}Running tests...${NC}"
  TEST_OUT=$(npm test --silent 2>&1) && TEST_RC=0 || TEST_RC=$?
  printf '%s\n' "$TEST_OUT" | tail -5
  if [ "$TEST_RC" -ne 0 ]; then
    echo -e "${RED}Tests failed. Fix before committing.${NC}"
    exit 1
  fi

  # `ℹ tests N` (spec reporter) or `# tests N` (TAP). Anchoring the digits to end
  # of line keeps a test NAME containing "tests 12" from matching, and tail -1
  # takes the trailing summary rather than the first line that happens to fit.
  ACTUAL_COUNT=$(printf '%s\n' "$TEST_OUT" | grep -oP '\btests \K\d+$' | tail -1 || true)
  if [ -n "$ACTUAL_COUNT" ] && [ -f CLAUDE.md ]; then
    CLAUDE_COUNT=$(grep -oP '\d+(?= 个测试)' CLAUDE.md | head -1 || true)
    if [ -n "$CLAUDE_COUNT" ] && [ "$CLAUDE_COUNT" != "$ACTUAL_COUNT" ]; then
      echo -e "${YELLOW}CLAUDE.md test count stale: $CLAUDE_COUNT → $ACTUAL_COUNT${NC}"
      sed -i "s/${CLAUDE_COUNT} 个测试/${ACTUAL_COUNT} 个测试/g" CLAUDE.md
      sed -i "s/运行全部 ${CLAUDE_COUNT}/运行全部 ${ACTUAL_COUNT}/g" CLAUDE.md
      # CLAUDE.md is gitignored — update locally only (not staged)
      echo -e "${GREEN}CLAUDE.md test count updated locally: $CLAUDE_COUNT → $ACTUAL_COUNT${NC}"
    fi
  fi
fi

echo -e "${GREEN}Pre-commit checks passed.${NC}"

#!/bin/bash
# GSD-Lite pre-commit hook
# Checks: 4-location version consistency, CLAUDE.md test count, lint, tests

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

# ── 2. CLAUDE.md test count sync ───────────────────────────
# Keep test count in CLAUDE.md accurate when test files change
STAGED_TESTS=$(git diff --cached --name-only --diff-filter=ACMRD | grep -E '^tests/' || true)
STAGED_CLAUDE=$(git diff --cached --name-only | grep -q '^CLAUDE.md$' && echo "yes" || true)

if [ -n "$STAGED_TESTS" ] || [ -n "$STAGED_CLAUDE" ]; then
  ACTUAL_COUNT=$(npm test --silent 2>&1 | grep -oP '# tests \K\d+' || true)
  if [ -n "$ACTUAL_COUNT" ]; then
    # Check CLAUDE.md for stale test counts
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

# ── 3. Lint check on staged src/tests/hooks files ─────────
STAGED_SRC=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^(src|tests|hooks)/' || true)
if [ -n "$STAGED_SRC" ]; then
  echo -e "${GREEN}Running lint...${NC}"
  npx biome check src/ tests/ hooks/ --no-errors-on-unmatched 2>/dev/null || {
    echo -e "${RED}Lint failed. Run 'npm run lint:fix' to auto-fix.${NC}"
    exit 1
  }
fi

# ── 4. Test run (only if src/ or tests/ changed) ──────────
# Skip if tests already ran for CLAUDE.md sync above
STAGED_CODE=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^(src|tests)/' || true)
if [ -n "$STAGED_CODE" ] && [ -z "$ACTUAL_COUNT" ]; then
  echo -e "${GREEN}Running tests...${NC}"
  npm test --silent 2>&1 | tail -5
  if [ ${PIPESTATUS[0]} -ne 0 ]; then
    echo -e "${RED}Tests failed. Fix before committing.${NC}"
    exit 1
  fi
fi

echo -e "${GREEN}Pre-commit checks passed.${NC}"

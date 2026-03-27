#!/bin/bash
# GSD-Lite pre-commit hook
# Checks: version consistency, lint, tests on staged files

set -e

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[0;33m'
NC='\033[0m'

# 1. Version consistency check — only if package.json is staged
if git diff --cached --name-only | grep -q '^package.json$'; then
  PKG_VER=$(node -e "console.log(JSON.parse(require('fs').readFileSync('package.json','utf8')).version)")

  PLUGIN_VER=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('.claude-plugin/plugin.json','utf8')).version)}catch{console.log('missing')}")

  MKT_VER=$(node -e "try{const m=JSON.parse(require('fs').readFileSync('.claude-plugin/marketplace.json','utf8'));console.log(m.plugins?.[0]?.version||'missing')}catch{console.log('missing')}")

  if [ "$PLUGIN_VER" != "missing" ] && [ "$PLUGIN_VER" != "$PKG_VER" ]; then
    echo -e "${YELLOW}Version mismatch: package.json=$PKG_VER, plugin.json=$PLUGIN_VER${NC}"
    echo -e "${GREEN}Auto-syncing versions...${NC}"
    node scripts/sync-versions.js 2>/dev/null || true
    git add .claude-plugin/plugin.json .claude-plugin/marketplace.json 2>/dev/null || true
    echo -e "${GREEN}Versions synced to $PKG_VER${NC}"
  fi

  if [ "$MKT_VER" != "missing" ] && [ "$MKT_VER" != "$PKG_VER" ]; then
    # Already handled by sync-versions above, but double-check
    echo -e "${YELLOW}marketplace.json version mismatch — syncing${NC}"
    node scripts/sync-versions.js 2>/dev/null || true
    git add .claude-plugin/plugin.json .claude-plugin/marketplace.json 2>/dev/null || true
  fi
fi

# 2. Lint check on staged src/tests/hooks files
STAGED_SRC=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^(src|tests|hooks)/' || true)
if [ -n "$STAGED_SRC" ]; then
  echo -e "${GREEN}Running lint...${NC}"
  npx biome check src/ tests/ hooks/ --no-errors-on-unmatched 2>/dev/null || {
    echo -e "${RED}Lint failed. Run 'npm run lint:fix' to auto-fix.${NC}"
    exit 1
  }
fi

# 3. Quick test run (only if src/ or tests/ changed)
STAGED_CODE=$(git diff --cached --name-only --diff-filter=ACMR | grep -E '^(src|tests)/' || true)
if [ -n "$STAGED_CODE" ]; then
  echo -e "${GREEN}Running tests...${NC}"
  npm test --silent 2>&1 | tail -5
  if [ ${PIPESTATUS[0]} -ne 0 ]; then
    echo -e "${RED}Tests failed. Fix before committing.${NC}"
    exit 1
  fi
fi

echo -e "${GREEN}Pre-commit checks passed.${NC}"

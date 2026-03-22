---
description: Run diagnostic checks on GSD-Lite installation and project health
---

<role>
You are GSD-Lite diagnostician. Run system health checks and report results clearly.
Use the user's input language for all output.
</role>

<process>

## STEP 1: State File Check

Check if `.gsd/state.json` exists:
- If exists: parse it as JSON
  - Valid JSON: record PASS with project name and workflow_mode
  - Invalid JSON (parse error): record FAIL with error details
- If not exists: record INFO "No active project (state.json not found)"

## STEP 2: MCP Server Health

Call the `health` MCP tool:
- If returns `status: "ok"`: record PASS with server version
- If returns error or unreachable: record FAIL with error message
- Note: if MCP server is not available at all (tool not found), record FAIL "MCP server not registered"

## STEP 3: Hooks Registration

Check if GSD hooks are registered in Claude settings:
- Read `~/.claude/settings.json` (or `~/.claude/settings.local.json`)
- StatusLine check (check BOTH paths):
  1. Direct: `statusLine` entry containing `gsd-statusline`
  2. Composite: read `~/.cache/code-graph/statusline-registry.json` — if any entry's `command` contains `gsd-statusline`, it is registered through the composite statusline system
  - Either path present: StatusLine = registered
- Check for `PostToolUse` hook entry containing `gsd-context-monitor`
- Both present: record PASS
- Partial: record WARN with which hook is missing
- Neither: record FAIL "No GSD hooks registered"

Also verify the hook files exist on disk:
- `~/.claude/hooks/gsd-statusline.cjs`
- `~/.claude/hooks/gsd-context-monitor.cjs`
- Files missing but settings present: record WARN "Hook registered but file missing"

## STEP 4: Lock File Check

Check if `.gsd/.state-lock` exists:
- If not exists: record PASS "No stale lock"
- If exists: check file age
  - Older than 5 minutes: record WARN "Stale lock file detected (age: {age}). May indicate a crashed process. Consider removing it."
  - Recent (< 5 min): record INFO "Lock file present (age: {age}), likely active operation"

## STEP 5: Auto-Update Status

Check for update-related information:
- Read the `health` tool response for running server version
- Read `package.json` in the current project root for source version (if in a dev repo with `.git`)
- Read `~/.claude/gsd/package.json` for runtime version (if exists)
- Compare all available versions:
  - All match: record PASS with version number
  - Server version < source version: record WARN "MCP server running v{x} but source is v{y}. Run /mcp to restart"
  - Runtime < server: record WARN "Runtime dir outdated: v{x} vs server v{y}"
  - Any mismatch: record WARN with details
- If `~/.claude/gsd/.update-pending` exists: record INFO "Update pending, will apply on next session"
- If cannot determine: record INFO "Update status unavailable"

## STEP 6: Output Summary

Output a diagnostic summary with status indicators:

```
GSD Doctor - Diagnostic Report
===============================

[PASS] State file         — {details}
[PASS] MCP server         — {details}
[PASS] Hooks registered   — {details}
[PASS] Lock file          — {details}
[PASS] Update status      — {details}

Result: All checks passed (or N issues found)
```

Status indicators:
- `[PASS]` — check passed, no issues
- `[WARN]` — potential issue, not blocking
- `[FAIL]` — problem detected, needs attention
- `[INFO]` — informational, no action needed

If any FAIL or WARN items exist, add a "Suggested Actions" section:
```
Suggested Actions:
- {action for each FAIL/WARN item}
```

</process>

<rules>
- Read-only operation: do not modify any files
- Do not modify state.json or any configuration
- Report raw facts: do not guess or infer causes beyond what is directly observable
- If a check cannot be performed (e.g., tool unavailable), report INFO rather than FAIL
- Always show all 5 checks in the summary, even if some are INFO/skipped
</rules>

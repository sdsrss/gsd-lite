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
- StatusLine check (registered if ANY path matches):
  1. Direct: `statusLine.command` contains `gsd-statusline`
  2. Composite cache registry: `~/.cache/code-graph/statusline-registry.json` — any entry whose `command` contains `gsd-statusline`
  3. Composite backup mirror: `~/.claude/statusline-providers.json` — same match rule (durable mirror written by code-graph's chain CLI)
  - Any path present: StatusLine = registered
- Determine the install mode first — hooks are registered in a different place
  for each, and checking only one reports a healthy install as broken:
  - **Plugin**: `~/.claude/plugins/installed_plugins.json` lists `gsd@gsd`, and
    `enabledPlugins["gsd@gsd"]` is not `false` in `~/.claude/settings.json` or
    the project's `.claude/settings.json` / `settings.local.json`. Claude Code
    loads the three hooks from `hooks/hooks.json` in the plugin cache; nothing
    appears in `settings.json` and nothing is copied to `~/.claude/hooks/`.
  - **npx / manual**: the three hooks are registered in `settings.hooks` and the
    five scripts sit in `~/.claude/hooks/`.
  - Both can be true at once. That is supported and is not a double
    registration: the `~/.claude/hooks` copies stand down while the plugin is
    installed and enabled, so each hook still fires once.
- Plugin mode — read `hooks/hooks.json` from the entry's `installPath` and check
  it declares `SessionStart`, `PostToolUse` and `Stop`:
  - All three declared: record PASS "hooks served by the plugin"
  - Partial or the file missing/unparseable: record FAIL naming what is absent,
    fix `/plugin update gsd`
- npx/manual mode — check the three hook arrays in `settings.hooks`:
  - `PostToolUse` entry referencing `gsd-context-monitor`
  - `SessionStart` entry referencing `gsd-session-init`
  - `Stop` entry referencing `gsd-session-stop`
  - All three present: record PASS
  - Partial: record WARN naming each missing hook, fix `npx gsd-lite install`
- Neither mode registers all three: record FAIL "No GSD hooks registered"
- StatusLine: PASS if registered by any path above. Absent on a plugin-only
  install is expected, not a failure — a plugin may not write the top-level
  `statusLine` key. Record INFO "StatusLine needs `npx gsd-lite install`".

Also verify the hook files exist on disk. These are written by install.js, so
check them only in npx/manual mode — a plugin-only install does not have them
and must not be reported as missing:
- `~/.claude/hooks/gsd-statusline.cjs`
- `~/.claude/hooks/gsd-context-monitor.cjs`
- `~/.claude/hooks/gsd-session-init.cjs`
- `~/.claude/hooks/gsd-session-stop.cjs`
- `~/.claude/hooks/gsd-auto-update.cjs`
- Files missing but settings present: record WARN "Hook registered but file missing"

## STEP 4: Lock File Check

Check if `.gsd/state.lock` exists:
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

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
- Note: if MCP server is not available at all (tool not found), record FAIL "MCP server not registered".
  Fix by install mode (STEP 3 says which): plugin — update or re-enable the gsd
  plugin; npx/manual — run `npx gsd-lite install`, which registers the server
  with Claude Code at user scope (`claude mcp add -s user gsd …`, needs `claude`
  on PATH) and prints the command to run by hand when it cannot. `claude mcp list`
  shows `gsd` once registered. Releases before 0.19.0 wrote the server only into
  `settings.json`, which Claude Code does not read MCP servers from, so an npx
  install from then has no gsd tools until it is reinstalled.

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
  - **Plugin**: `~/.claude/plugins/installed_plugins.json` lists `gsd@gsd` with
    a record that applies to this project (no `scope`, `user` or `managed`
    scope, or `project` / `local` scope whose `projectPath` is this project;
    a record for another project serves that project only), and
    `enabledPlugins["gsd@gsd"]` is not `false` in `~/.claude/settings.json` or
    the project's `.claude/settings.json` / `settings.local.json`. Claude Code
    loads the three hooks from `hooks/hooks.json` in the plugin cache; nothing
    appears in `settings.json` and nothing is copied to `~/.claude/hooks/`.
  - **npx / manual**: the three hooks are registered in `settings.hooks` and the
    five scripts sit in `~/.claude/hooks/`.
  - Both can be true at once, and that is supported. The `~/.claude/hooks`
    copies stand down, so each hook fires once, only when the files show the
    plugin serving this directory: the first entry under `gsd@gsd` (without
    one, under the first `gsd@…` id) is unscoped, at `user` scope, or at
    `project` / `local` scope for this directory;
    `enabledPlugins["gsd@gsd"]` is `true` in `~/.claude/settings.json` or the
    project's `.claude/settings.json` / `settings.local.json`, and no other of
    them says otherwise; and the plugin's `hooks/hooks.json` declares the hook.
    Otherwise both copies run and each hook fires twice: record INFO "hooks
    from both the plugin and the npx install run", not a failure. A plugin
    installed by policy (`managed` scope) is enabled by managed settings these
    files do not show, so beside one both copies run.
- Plugin mode — read `hooks/hooks.json` from the entry's `installPath` and check
  it declares `SessionStart`, `PostToolUse` and `Stop`:
  - All three declared: record PASS "hooks served by the plugin"
  - Partial or the file missing/unparseable: record FAIL naming what is absent,
    fix: update the plugin — in a session `/plugin` → **Installed** → gsd → **Update now**,
    or from a shell `claude plugin update gsd@gsd` — then restart Claude Code
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
- If exists: check file age. The lock is held only for the duration of one state write, and the
  server treats a lock older than 10 seconds as abandoned and breaks it on the next write.
  - Older than 10 seconds: record WARN "Stale lock file (age: {age}) — a process likely exited mid-write. The next state write clears it; no manual removal needed."
  - Younger: record INFO "Lock file present (age: {age}), likely an active write"

## STEP 5: Auto-Update Status

Check for update-related information:
- Read the `health` tool response for running server version
- If the `health` response carries `warning` (the server's own version-drift check): record it as WARN
- Read `package.json` in the current project root for a source version only when its `name` is `gsd-lite`,
  i.e. you are inside the gsd-lite repository itself. In any other project that file is the project's own
  version, not gsd's: skip the server-vs-source comparison
- Read `~/.claude/gsd/package.json` for runtime version (if exists)
- Compare all available versions:
  - All match: record PASS with version number
  - Server version < source version: record WARN "MCP server running v{x} but source is v{y}. Run /mcp to restart"
  - Runtime < server: record WARN "Runtime dir outdated: v{x} vs server v{y}"
  - Any mismatch: record WARN with details
- If `~/.claude/gsd/runtime/update-notification.json` exists, it is the result of the
  last background update check. Parse it and record by its `kind`:
  - `available` (with `from`, `to`, `action: "plugin_update"`): INFO "Update available: v{from} → v{to}" — a plugin install is updated by the plugin system, not by gsd: `/plugin` → **Installed** → gsd → **Update now**, or `claude plugin update gsd@gsd` from a shell
  - `updated` (with `from`, `to`): INFO "Auto-updated v{from} → v{to}; restart Claude Code to load it"
  - `failed` (with `from`, `to`): WARN "Update to v{to} failed; still on v{from}", fix `gsd update` (or `npx gsd-lite update`) to see why
  - `check_failed` (with `count`, `since`, `reason`): WARN "Update checks failing: {count} in a row since {since} — {reason}" (the reason is described below)
  - The SessionStart hook prints this file and then deletes it, so it is usually absent. Absence is normal: record nothing for it.
- If `~/.claude/gsd/runtime/update-state.json` has `checkFailure` (`count`, `since`, `reason`) with a `count` of 3 or more, the update checks are failing now: WARN "Update checks failing: {count} in a row since {since} — {reason}". Fewer than 3 is a blip, which SessionStart does not report either: record nothing. The reason ends with what happened to a proxy, when the environment sets one:
  - `(through the proxy set in the environment)`: the proxy was used and the request still failed; the proxy or the network is the thing to check
  - `(... only when started with NODE_USE_ENV_PROXY=1)`, `(... it needs v22.21+ or v24+)`, `(... NODE_USE_ENV_PROXY keeps Node from using it)`: each names the setting to change
  - `(... that Node refused to use)`: Node does not accept the proxy value (for example `host:port` with no scheme, a path after the port, or a `%` in the password that is not an escape); it needs to be an `http://` or `https://` URL Node can parse
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

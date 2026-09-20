# Changelog

All notable changes to this project are documented here.

## [Unreleased]

**A project can no longer paint itself into a corner, and a failed update can no
longer break the one you have.** This is the P0 and the eight P1 findings from
the 2026-09-20 audit, which read the whole codebase looking for states the
orchestrator could reach and not leave.

Minor, not patch: `orchestrator-resume` gains a `recovery` parameter.

**Three ordinary things used to end a project permanently.**

- A debugger result with `architecture_concern: true` put the whole workflow in
  `failed`, which had no outgoing transition, refused every mode change, and
  refused plan patches. The only exits were `state-init force:true` — which
  destroys the plan — and editing `state.json` by hand. Meanwhile resume
  advertised `recovery_options: ['retry_failed','skip_failed','replan']` that
  nothing in the codebase read. Those three options now work, through
  `orchestrator-resume recovery:'…'`. `retry_failed` requeues the failed tasks
  with a fresh retry budget; `skip_failed` leaves them failed and continues with
  whatever can still run; `replan` returns to planning.
- Editing the plan and committing while in `replan_required` made every
  subsequent resume fail. Preflight detected the moved HEAD and tried to write
  `reconcile_workspace`, which that mode's transition whitelist rejected — so
  nothing was written, the condition stayed, and the next resume hit the same
  wall. Every non-terminal mode now reaches all four modes preflight can impose.
- Phase review failing five times parked the workflow in `awaiting_user` and
  said user intervention was required, but resume recognised only two review
  stages and everything else fell through to auto-unblock, which cleared the
  hold and went straight back into the same review with the retry counter still
  climbing. Any named review stage is now a real hold, cleared only by an
  explicit `recovery`, which also resets the counter.

**Background updates can no longer leave you without a working GSD.** `install.js`
wiped the runtime directory and ran `npm ci` about a hundred lines later, so any
dependency install that could not finish — no network, a registry error — left
`~/.claude/gsd` with new source and no `node_modules`, and the MCP server threw
`ERR_MODULE_NOT_FOUND` on every start after that. It was also permanent and
silent: the new `package.json` was written before `npm ci`, so the version check
read the new number off the broken install and concluded it was already up to
date, and the notification file was only ever written on success. The installer
now builds into a staging directory and swaps at the end, so a failure leaves
the previous runtime untouched and the next check retries by itself. **You do
not need to do anything.** If an earlier update already broke your runtime, run
`npx gsd-lite install` once.

A failed update now prints a line at session start instead of nothing.

**Hooks stop standing down when the plugin is not actually serving them.** The
guard treated a missing `enabledPlugins` entry as "enabled", which is exactly
what `/plugin install --scope project` produces in every *other* project: the
plugin does not load there, the `~/.claude/hooks` copy stepped aside anyway, and
the result was zero hooks with nothing on disk saying so. An explicit `true` is
now required, and a project-scoped record only counts inside the project it
names.

**Security.** The Stop hook, the statusline and the context monitor wrote through
predictable temp filenames — `.gsd/.session-end.<pid>.tmp` and two in the shared
temp directory. A repository (or, for the temp-directory ones, another local
user) could pre-create those paths as symlinks and have the hook write through
them. 0.9.0 fixed this for the SessionStart hook but left the hardened helper
inline in that file; it now lives in `hooks/lib/atomic-write.cjs` and all four
hooks use it.

Releases are also signed and verified *before* `npm publish` rather than after.
A signing key that no longer paired with the public key embedded in the client
used to mean npm got the version permanently, the job then failed, and
auto-update clients — which read GitHub Releases, not npm — never saw that
release or any later one.

**Also fixed**

- Executor and debugger results for a task that already checkpointed are
  rejected instead of cancelling the review in progress and recording a retry
  against work that had not failed.
- Blockers had three different shapes across the tool schema, the reader and the
  executor contract, so `blocked_reason` always fell back to the task summary
  and `unblock_condition` was always null despite three commands promising to
  show them.
- `reviewer.md` now states that `spec_passed`/`quality_passed` are rework
  switches, not grades — a `false` with no task named makes the server mark
  every completed task in the phase for revalidation.
- The "start over" option in `/gsd:start` and `/gsd:prd` needs `force: true`,
  which the `state-init` template never mentioned, so it returned `STATE_EXISTS`
  and did nothing.
- `resume.md` no longer asks the model to redo the preflight the server has
  already done and persisted, and the action table no longer treats the first
  sighting of a moved HEAD as a full stop while treating the second as
  automatic.
- A CI step named "Check coverage threshold" could not fail: it shelled out to
  `c8`, which is not on `PATH` inside `run:`, and exited 0 every time. The real
  gate is c8's own `--check-coverage` in `test:coverage`.

## [0.10.0] - 2026-09-20

**A plugin install now actually installs the hooks.** Found by running the
install → use → update → self-heal → uninstall path as a new user would, against
a real `/plugin install` into a throwaway config directory.

Minor, not patch: if you installed with `/plugin install gsd`, hooks that were
silently inert now run, and you will see behaviour you have not seen before.

**If you installed via `/plugin`, upgrading turns three hooks on for the first
time.** Nothing to do to get them — `/plugin update gsd` and restart. What
changes in a session:

- SessionStart writes a marker-delimited progress block into your project's
  `CLAUDE.md` when a `.gsd/` project is present. Opt out with
  `GSD_NO_CLAUDEMD_STATUS=1`; the block is idempotent and bounded by
  `<!-- GSD-STATUS-BEGIN -->` / `<!-- GSD-STATUS-END -->`.
- PostToolUse injects a context warning below 35% remaining, Stop writes a
  crash marker, and update checks resume (plugin installs are notified only —
  they never self-install; you run `/plugin update gsd`).
- A plugin-path session now creates `~/.claude/gsd/runtime/` (two small files
  holding update-check throttle state). `/plugin uninstall` does not remove it;
  `npx gsd-lite uninstall` does.

If you have **both** an npx install and the plugin, nothing fires twice and
there is nothing to do. Both registrations stay in place; the copies under
`~/.claude/hooks` stand down while the plugin's are live, and take over again
the moment the plugin is removed. Deleting a registration to achieve that was
tried first and was wrong: the `settings.json` one is the only GSD code that
still runs after `/plugin uninstall`, so removing it left a complete npx
install on disk with nothing registered, nothing able to notice, and no
message saying so.

**If you installed with npx before adding the plugin, run `npx gsd-lite install`
once after upgrading.** A 0.9.0-era `~/.claude/hooks/*.cjs` has no stand-down
check yet and fires alongside the plugin's copy. The auto-updater refreshes
those scripts on its own for most people, but one ordering — an old npx install
run *after* the plugin was added — leaves auto-update in notify-only mode, so
nothing refreshes them. One command settles it either way.

Seeing `Hooks (3)` from `claude plugin details gsd` *and* three entries in
`settings.json` is correct, not a double registration — only one of the two
copies executes.

`claude plugin details` reports `MCP servers (0)` for this version. That is a
display limitation of the CLI, which counts only a root `.mcp.json` and not an
inline declaration in `plugin.json`; `claude plugin list --json` reports the
server correctly and it connects normally.

To stay on the old behaviour: `npm i gsd-lite@0.9.0`, or keep the plugin at
0.9.0 and skip the update.

### Fixed

- **`/plugin install gsd` registered zero hooks.** `hooks/hooks.json` shipped
  emptied out — a 0.7.x change moved registration into `settings.json` on the
  belief that the plugin system's `hooks.json` loading was unreliable. Only
  `install.js` writes `settings.json`, and the plugin system never runs it, so
  the recommended install path silently had no SessionStart, no PostToolUse and
  no Stop hook: no project status injection, no context monitoring, no crash
  marker, no update checks. `claude plugin details gsd` reported `Hooks (0)`
  while the README promised the opposite. `hooks/hooks.json` declares the three
  hooks again. Both install paths keep their registrations; the redundant copy
  stands down at runtime, so exactly one of them fires.
- **The repository's own `.mcp.json` broke the MCP server for anyone who opened
  the repo.** A `.mcp.json` at the repo root is the plugin's MCP manifest *and*
  project-scope MCP config for any Claude Code session whose working directory is
  the repo — and `${CLAUDE_PLUGIN_ROOT}` does not expand in the latter, so the
  entry failed with `Missing environment variables: CLAUDE_PLUGIN_ROOT` and
  shadowed the user's working install. The server is now declared inline in
  `.claude-plugin/plugin.json` and the root `.mcp.json` is gone.
- The marketplace listing advertised 5 commands and 5 workflows; there are 6 of
  each.
- `scripts/sync-versions.js` no longer rewrites `installed_plugins.json` and
  hand-builds a plugin cache directory by default. It copied a subset of the tree
  — no `install.js`, `uninstall.js` or `cli.js` — and pointed the registry at it,
  so `claude plugin update gsd` then answered "already at the latest version" for
  a build the plugin manager never installed, and the only copy being dogfooded
  was one no user ever gets. Set `GSD_SYNC_PLUGIN_CACHE=1` to opt in; the copy
  now mirrors a real install.
- **Editing `settings.json` hooks could delete another tool's hook.** Claude
  Code groups hooks by matcher and several tools routinely share a group; every
  place that touched the `hooks` object — `install.js` registering,
  `uninstall.js` removing, and the orphan cleanup inside the SessionStart hook —
  edited at group granularity, so a GSD hook sharing a matcher group took its
  neighbours with it. Installing or uninstalling GSD silently destroyed them.
  They now share `hooks/lib/hook-registry.cjs`, which strips exactly one hook
  and keeps the group for whoever else is in it.
- Added the `LICENSE` file that `package.json` has always claimed.
- `commands/resume.md` named `gsd:executor` as the only agent id. That is the
  plugin form; an npx/manual install registers the agents unprefixed, so the
  command now names both and says to go by the session's actual agent list.
- Deleted `hooks/context-monitor.js`, an ESM wrapper with no importers whose
  thresholds and message text duplicated `gsd-context-monitor.cjs` and had
  drifted from it. `tests/e2e-context-health.md` documented a CLI on that file
  which never existed; it now documents the real stdin/stdout hook contract,
  with a repro command that was run before it was written down. Also deleted
  `.npmignore`, dead since `package.json` gained a `files` allowlist.

### Changed

- StatusLine is documented as needing `npx gsd-lite install`. A plugin may not
  write the top-level `statusLine` key in `settings.json`, so a plugin-only
  install cannot register it — previously this was advertised as automatic.
- A plugin-path session now creates `~/.claude/gsd/runtime/` (update-check
  throttle state, two small files), because the SessionStart hook runs again.
  `/plugin uninstall` does not remove it; `npx gsd-lite uninstall` does.

### Added

- `tests/hook-registry.test.js` — pins hook-granularity editing through the
  call sites, and pins stand-down for all three hooks in both directions:
  suppressed while the plugin serves, running when it is absent, disabled, or
  its registry is unreadable.
- `tests/plugin-manifest.test.js` — asserts what a `/plugin install` delivers by
  reading the shipped manifests rather than by driving `install.js`: every hook
  in `install.js`'s registry is declared in `hooks/hooks.json` with the same
  matcher and timeout, every hook command is rooted at `${CLAUDE_PLUGIN_ROOT}`
  and points at a file that exists, no `.mcp.json` sits at the repo root, and the
  advertised command/agent/workflow/tool counts match the tree.

## [0.9.0] - 2026-09-19

**Security release.** Three ways a repository you clone could act on your
machine are closed. They are present in 0.8.6 and every earlier version, not
introduced here.

Upgrading from 0.8.x: `gsd install` and `gsd uninstall` now exit non-zero
instead of 0 when they refuse to act. If a script of yours branches on those
exit codes, read Changed below. To stay on the old behaviour:
`npm i gsd-lite@0.8.6`.

### Security

- **A cloned repository could write to any file you can write to.** The
  SessionStart hook wrote through a temp file named `<path>.gsd-tmp-<pid>`,
  which a repository can create in advance. Writing follows a symlink, so a repo
  shipping links at those names got the hook to overwrite a file of its choosing
  — `~/.bashrc`, `~/.claude/settings.json`, anything — and then left that path
  installed as the project's `CLAUDE.md`. Opening the project in Claude Code was
  the only action required. The temp file is now created with `O_EXCL` and a
  random suffix, so an existing path fails the open instead of being followed,
  and every write in the hook goes through that one function.
- **A repository could put its own instructions into `CLAUDE.md`.** Claude Code
  reads that file as instructions, and the status block interpolated fields
  straight from the repository's `.gsd/state.json`. Three of them were never
  filtered. All values are now sanitized once, up front, and the block renders
  only from the sanitized copy — a field that is not sanitized cannot reach it.
  Control characters, format and bidi controls, and the U+2028/U+2029 line
  separators are stripped.
- **The same injection reached the model directly.** The session-end timestamp
  went unfiltered into the hook's stdout, which SessionStart hands the model as
  context. It is filtered now.
- A `CLAUDE.md` that is a symlink is no longer replaced with a regular file, so
  a dotfiles or shared-team setup keeps working. A link resolving outside the
  project is left alone entirely rather than followed; set
  `GSD_NO_CLAUDEMD_STATUS=1` if you would rather the hook never touched
  `CLAUDE.md` at all.

### Changed

- `gsd install` refuses to run when `~/.claude/settings.json` cannot be read or
  parsed, and exits 1. It used to continue with an empty object and write that
  back, destroying your `model`, `permissions` (deny rules included), `env`,
  `enabledPlugins` and every other plugin's hook registrations, then report
  success. Nothing is copied when it refuses, and `--dry-run` reports the same
  blocker.
- `gsd uninstall` refuses to run against a directory that does not exist, and
  exits 1. Pointed at a typo'd `CLAUDE_CONFIG_DIR` it used to remove nothing and
  print "GSD-Lite uninstalled" while the real install kept running. A run that
  removes nothing now says so instead of claiming an uninstall.

### Fixed

- `state-patch add_task` validates its `requires` entries the way the other
  plan-authoring paths do. A dangling task id, a cross-phase task dependency, an
  out-of-set gate, a bare string or an unknown kind used to be stored as written.
  The scheduler treats a dependency it cannot resolve as satisfied, so the
  ordering you asked for silently disappeared and tasks ran alongside their own
  prerequisites.
- A task index that cannot be incremented no longer wedges a phase. An index at
  or past 2^53, or an existing id with no numeric part, made every later
  auto-indexed `add_task` fail with "already exists" forever, and could persist a
  task literally called `1.NaN`.
- Reinstalling keeps `~/.claude/gsd/runtime/`. A read failure while it was being
  staged used to lose the update state the step promises to preserve, and leave a
  `.gsd-runtime-backup-<pid>` directory behind in your config directory — one per
  failed attempt. Any stranded by earlier versions are swept up.
- A `settings.json` write by a running Claude Code session during an install is
  no longer discarded. The installer reads the file immediately before writing it
  rather than holding a copy taken before the file copies and `npm ci`.
- An unreadable `settings.json` (wrong owner, restrictive permissions) gets the
  same guidance as an unparseable one instead of a raw stack trace.
- `gsd update` stops reporting outcomes it does not have. An offline run said
  "Could not fetch latest release" and "Already up to date" in consecutive lines;
  a throttled run with a cached result claimed the install had failed when none
  was attempted. A throttled plugin install is pointed straight at
  `/plugin update gsd`.
- The three documentation links in the README pointed at a directory that is not
  in the repository and returned 404 for every reader.

### Known issues

Two defects found during this release are left open. Both predate 0.8.6 and
neither is made worse here. Attempted fixes were reverted because each traded
the defect for a new one.

- A task-kind dependency gated on `phase_complete` is accepted at authoring time
  but blocked forever by the scheduler, so the phase can never complete.
  Recovery needs hand-editing `state.json`. Avoid that combination; use
  `checkpoint` or `accepted` on task dependencies.
- `gsd uninstall` can delete the hook files and then fail to deregister them
  from `settings.json`, leaving entries that point at deleted paths. It reports
  success either way. If an uninstall looks wrong, check `settings.json` for
  remaining `gsd` entries under `mcpServers`, `statusLine` and `hooks`.

### Internal

- The repo's own pre-commit hook is tracked executable, so the lint and test
  gate it defines actually runs. It never had for anyone who cloned.
- Regression gates added: every relative link in tracked Markdown must resolve,
  and every git hook `npm run prepare` installs must be tracked 100755.
- `.converge/` carries the maintenance loop's state — baseline, backlog,
  metrics, recurring defect shapes, and the decisions still open.

# Changelog

All notable changes to this project are documented here.

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

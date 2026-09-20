# Changelog

All notable changes to this project are documented here.

## [0.12.0] - 2026-09-20

**Coming from 0.11.1, this also carries everything in the 0.11.2 entry below** —
that version was merged but never published, so its two silent failures (a
`gsd uninstall` that could report success after leaving your hooks registered,
and a plan that could be accepted and then never finish) are fixed here too.

Minor rather than patch: resume gains a `warnings` array, and three contracts
now refuse input they used to accept quietly.

**Four things were written down and never read.** Each looked implemented from
the writing side, which is why they lasted.

- **Context-exhaustion warnings could go silent for a whole session, and
  nothing could recover it.** The statusline hands the context monitor a file
  in the shared temp directory. A *directory* planted at either path pinned it:
  `rename` cannot replace a directory, `/tmp` is sticky so another user's
  directory cannot be removed by us either, and the self-heal is the rename
  that cannot happen. Those files now live in `$XDG_RUNTIME_DIR/gsd`, or
  `<config dir>/gsd/runtime/ctx` where that is unset — a directory only you can
  enter, verified before use rather than assumed: a real directory, not a
  symlink, owned by you, with no group or other write bit. **You do not need to
  do anything**; stale files in the old location are swept at session start.
  (#8)
- **A high-confidence task could skip independent review on the strength of
  evidence that a test had failed.** The orchestrator drops an L1 task to L0
  unless an evidence entry is a test that did not pass — but nothing ever asked
  executors for that verdict, so the check that withheld the downgrade could
  not fire, and "has evidence at all" was the whole test. Evidence entries now
  carry `type` and `passed` in the tool schema, the executor contract and the
  evidence spec, and the fields are validated: `passed: "no"` is refused rather
  than read as a pass. Entries missing `id` or `scope` are refused too — those
  were dropped from the record while still counting as evidence.
- **Removing a task could remove a different one.** Task ids are
  `<phase>.<index>` and unique plan-wide, and `state-update` was the one path
  that did not check: a task could arrive in phase 2 carrying id `1.1`, after
  which removing `1.1` deleted whichever copy came first and reported success.
  Ids are now checked where they enter, and `remove_task` refuses an ambiguous
  id instead of guessing. A state that already holds a duplicate stays
  writable, so it can be repaired rather than frozen.
- **An interrupted research write left a marker nobody read.**
  `.gsd/.research-commit-pending` means a crash landed between writing the
  research artifacts and writing the state that references them, so the two may
  not agree. Resume now reports it, says re-running research rewrites both, and
  leaves the marker alone — clearing it on report would turn a standing
  condition into a notice that whoever was not looking never sees again.

**Also**

- The phase-review gate was written out three times and had already drifted.
  One predicate now answers it, so resume cannot advertise a phase completion
  that `phase-complete` then refuses.
- The test suite no longer fails at random on Node 20, and no longer writes
  into a real `~/.claude` while running.

## [0.11.2] - 2026-09-20

**`gsd uninstall` could report success after leaving your hooks registered.**
It deletes the hook files first and deregisters them second, and every registry
edit sat in a bare `catch`. A `settings.json` it could not parse therefore
produced: files gone, hook and MCP entries still registered at paths that no
longer exist, `✓ GSD-Lite uninstalled.`, exit 0. Every session after that ran a
hook command that was not on disk, and the only line you read said it had
finished. The same silence covered `known_marketplaces.json`,
`installed_plugins.json`, the composite statusLine registry, and a missing
`hook-registry.cjs` helper.

The closing line and the exit code now come off one object, so they cannot
disagree: everything removed → exit 0 and the success line; nothing installed →
exit 0 and "Nothing to remove"; any step that did not finish → exit 1, naming
each one and what it leaves behind. A registry file that is simply absent stays
a non-event. An earlier attempt at this was reverted for printing a new message
and still exiting 0 (7b39ae0), which is why the two are now read from the same
field rather than kept in step by hand.

**A plan could be accepted and then never finish.** A task dependency gated on
`phase_complete` — `{kind: 'task', id: '1.1', gate: 'phase_complete'}` — passed
all three authoring paths (`state-init`, `state-patch add_task`, `state-patch
add_dependency`) and was refused by the scheduler on every call. The task never
became runnable, so the phase never reached all-accepted, so `current_phase`
never moved past it. The plan was valid, the project could not be finished, and
the only ways out were `replan` or editing `state.json` by hand.

Gates are per dependency kind, and the three authoring paths each checked them
against one flat set. The vocabulary now lives beside the scheduler semantics
it was read off — a task dependency takes `checkpoint` or `accepted`, a phase
dependency also takes `phase_complete` — and both sides import it. This is a
patch, not a breaking change: the pair it now rejects at authoring time is the
one that could never run.

Writing the test for that turned up a second hole in the same place: a gate
outside the vocabulary, or a dependency kind that is neither `task` nor
`phase`, fell through every branch of the scheduler and was treated as
*satisfied* — silently dropping the ordering the plan asked for. Those arrive
only from a hand-edited or foreign-version `state.json`, which is exactly when
a quiet answer is worst. Unresolvable now means unsatisfied, and `resume` says
the task can never run as written instead of describing a wait that will not
end.

**Also**

- The test suite no longer fails at random on Node 20. `git commit` forks
  `git maintenance run --auto --detach`, which was still writing inside `.git`
  when a fixture removed its temp repo — `ENOTEMPTY`, in whichever of the nine
  git fixtures lost the race (#9). Every git the suite runs now reads a fixture
  config with `gc.auto=0`, so there is no background writer to race.
- The linter covers `cli.js`, `install.js`, `uninstall.js`, `launcher.js` and
  `scripts/**` for the first time — the files a user runs before anything else
  works, and where the last three reverted bugs lived.

## [0.11.1] - 2026-09-20

**`skip_failed` refused when a sibling task was still running, and resume kept
offering it anyway.** The ordinary shape after a parallel dispatch: one task goes
to the debugger and fails, another is still running. `skip_failed` returned
`TRANSITION_ERROR` — "nothing else in that phase can run" — while resume went on
listing `skip_failed` in `recovery_options` every time. So the release whose
whole subject is options that were advertised and never implemented shipped one
of its own, inside the fix for it. Measured: three calls, three refusals, the
option re-offered after each. `retry_failed` still worked, so no project was
stuck, but the advertised path was a dead one.

The cause was a guard that predicted what the scheduler would do instead of
asking it. `resumeExecutingTask` re-dispatches a running task *before* it
consults `selectRunnableTask`, and `selectRunnableTask` ignores every lifecycle
outside `pending` and `needs_revalidation` — so a guard built on that function
alone cannot see a running task at all. Both now go through one
`phaseHasWork(phase, state)`: one function, two callers, one place to be wrong.

The 0.11.0 note below claimed the guard asks "whether resume would come back
asking the same thing". That was not true of the code as shipped — in this exact
case resume did come back asking, and the guard refused anyway. It is true now.

There is a test for the property rather than the case: for every shape of a
failed task with a sibling — runnable, blocked, running, accepted — sending
`skip_failed` must either make progress or refuse while naming a recovery option
that actually works. Each of the three revisions of this guard broke a shape the
previous one handled, because each was checked by example.

## [0.11.0] - 2026-09-20

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

`skip_failed` refuses rather than reporting a success it did not achieve. It
means "leave these failed and get on with the rest", so it needs a rest to get
on with. (As shipped in 0.11.0 this check missed a task left `running`; see the
0.11.1 note above. The description below is of the corrected behaviour.) The
question it asks is whether resume would just come back asking the same thing —
the loop it exists to prevent. Two things follow. The rest has to be in the *current* phase, because a phase holding a
failed task can never be accepted and `current_phase` never advances past it, so
later-phase work cannot be reached from there. And a task that is merely waiting
on you still counts as somewhere to go: a blocked sibling puts the workflow into
`awaiting_user` with the blockers listed, which you clear with `unblock_tasks`.
What does not count is a task nothing can move — a pending one whose dependency
is the task that just failed. The refusal tells you which case you are in and
names what is holding each remaining task, because "no other work remains" reads
as wrong to anyone looking at a pending phase 2, and so does refusing with no
reason given.

`recovery` can no longer be sent alongside `unblock_tasks` or `confirm_review`.
They are three different ways to resolve a hold, the combination is refused as
`INVALID_INPUT`, and it is refused before anything is written — the pair used to
commit the first action, including an L3 human sign-off, and then return an
error the caller would reasonably read as "nothing happened".

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
inline in that file; it now lives in `hooks/lib/atomic-write.cjs` and every
write in the hooks, the installer and the uninstaller goes through it — including
the ones to `~/.claude/settings.json` and `installed_plugins.json`, which the
first pass of this change left on the old pattern while the commit message
claimed the class was closed.

Reads of those files are guarded too. A symlink pointing at a fifo made
`readFileSync` block forever rather than fail, so a repository shipping one at
`.gsd/.context-health` hung the statusline on every render — and since the read
happens before the write decision, no amount of write-side hardening touched
it. The guard covers every read on a path a checkout controls, not just the one
that was reported: `.gsd/state.json`, read on every render; `.gsd/.session-end`
and the project `CLAUDE.md`, both read by SessionStart. Those last two were the
worse ones — a fifo at either hung the session before it started.

Two different guards, because the two kinds of path have opposite link
semantics. Files GSD owns are written by a rename, which replaces a symlink, so
a link on one is an obstruction and the reader refuses it. A project `CLAUDE.md`
is yours — a dotfiles or shared-repo setup symlinks it deliberately and the
writer follows it on purpose — so its reader follows the link too and rejects
only what the link lands on. Reading that one as absent would have been worse
than not guarding it: the hook would have treated empty as the whole file and
written its status block through the link over your contents.

**A `CLAUDE.md` the hook cannot read is now left alone.** "Not there" and "could
not read it" were the same answer to the code: it started from an empty string,
generated the status block, and renamed that over the file. A `CLAUDE.md` with
its permissions set to 000 lost its contents that way — 40 bytes of notes
replaced by 178 bytes of generated block, exit 0, nothing said. Nothing there is
safe to create over; something there that cannot be read is not. A fifo or a
directory at that path still gets replaced, which is right, since neither holds
anything anyone can lose.

The reads of GSD's own files also go through one helper that returns nothing
unless the bytes parsed to a plain object. Both halves earned their place.
`JSON.parse(null)` returns null instead of throwing, so a `try`/`catch` around
the parse never fires and the caller adopts the null. And `typeof [] ===
'object'`, so an array planted at the context monitor's debounce path in the
shared temp directory was adopted as state — assigning the counter to it works,
`JSON.stringify` drops it again, and the warning was suppressed for the rest of
the session by a single write of `[]`. That closes the cheapest way to silence
the context warning, not the whole class: see Known issues below.

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

### Known issues

One defect found during this release is left open. It predates 0.11.0 and is not
made worse here.

- A **directory** planted at `$TMPDIR/gsd-ctx-<session>.json` or at
  `$TMPDIR/gsd-ctx-<session>-warned.json` pins that path: `rename` cannot
  replace a directory, so the statusline can never write the bridge file again
  and the context-exhaustion warning stays silent for that session. The symlink
  version of this is fixed — a link gets evicted — but the directory version is
  not, and the reason it is left alone is that the obvious fix does not work:
  `/tmp` is sticky on Linux, so a directory another user created cannot be
  removed by us either. Teaching the shared atomic-write helper to delete
  directories would buy nothing against the case it was written for while giving
  a helper that writes `~/.claude/settings.json` the power to remove a
  directory. If context warnings go quiet on a shared host, check
  `ls -ld $TMPDIR/gsd-ctx-*`. Tracked in #8, where the fix worth costing out is
  moving these two files out of the shared temp directory rather than reacting
  to what gets planted in it.

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

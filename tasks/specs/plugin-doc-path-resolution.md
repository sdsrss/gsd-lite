---
status: implemented
revision: 2
---

# Plugin doc path resolution

## Goal

Every path the prompt layer hands an agent resolves to a real file, from any working
directory, in both install modes.

## Problem

`commands/start.md:42` tells the agent to Read `references/questioning.md`; `:58` and
`commands/prd.md:73` say `workflows/execution-flow.md`; `src/tools/state/logic.js:312-314`
hands executors `workflows/tdd-cycle.md`, `workflows/deviation-rules.md`,
`workflows/debugging.md`, `workflows/research.md`. All bare relative paths.

They only resolve when the working directory is the plugin root. A user's working
directory is their own project, where none of them exist — verified against a real
0.12.1 marketplace install into a throwaway `CLAUDE_CONFIG_DIR`.

The two install modes put the same file at different depths:

| mode | location | tail |
|---|---|---|
| plugin | `<cfg>/plugins/cache/gsd/gsd/<version>/references/questioning.md` | `references/questioning.md` |
| npx / manual | `<cfg>/references/gsd/questioning.md` | `references/**gsd/**questioning.md` |

So no single relative string can be correct for both — the npx layout carries a `gsd/`
segment the instruction does not have. That half needs no knowledge of how the harness
resolves paths.

It survived because the gsd-lite source repo is the one working directory where every
one of these paths resolves. Nothing run from the repo can see it.

## Non-goals

- Rewriting the content of `references/` or `workflows/`. Measured: cross-file duplication
  is 753 characters, 0.9% of the prompt layer. Not worth touching 24 files.
- `state-read` returning `{}` for an absent field. Separate contract, separate round.
- Issue #10. Needs a transactional boundary, not a path fix.
- Deciding whether plugin mode currently limps along on undocumented fallback behaviour.
  The fix makes the question moot; see Open questions.

## Constraints

- **Both install modes.** `CLAUDE_PLUGIN_ROOT` is set only under the plugin system —
  `hooks/lib/hook-registry.cjs:43` already uses its absence as the npx-mode detector. Any
  fix that depends on it alone fixes half the users.
- **The server already knows.** `plugin.json` launches `${CLAUDE_PLUGIN_ROOT}/launcher.js`,
  and `launcher.js:10` derives `__dirname` from `import.meta.url` before importing
  `src/server.js`. In both modes the server process runs from the install root, so it can
  compute these paths with no environment dependency. That is the single source of truth.
- **One resolver, not one fix per call site.** Every previous round of this class in this
  repo regressed because the fix landed at a call site and the next call site repeated the
  bug. A shared resolver means the next caller inherits it.
- **No new runtime dependency**, and no change to what ships in `files`.

## Success criteria

1. `buildExecutorContext` returns absolute paths that exist on disk, verified by a test
   that stats them rather than matching their shape.
2. No file under `commands/`, `agents/`, or `workflows/` instructs an agent to read a
   bare relative path into `references/` or `workflows/`.
3. A repo gate fails when criterion 2 is violated — the gate is the deliverable, not the
   individual edits. It must be shown to go red on the pre-fix content.
4. The resolver is proven from a working directory that is **not** the package root; a
   test that runs with `process.cwd()` set elsewhere and still resolves.
5. `npm test` green; no change to the shipped `files` list.

## Open questions

- Whether Claude Code's Read applies plugin-root fallback to a relative path in a command
  body is still unconfirmed — `claude-code-guide` could not cite documentation and said so
  rather than guessing. This spec does not depend on the answer: absolute paths from the
  server are correct under either behaviour. If the answer later turns out to be "there is
  fallback", criterion 2 is still right, because npx mode has no such luck.
- `${CLAUDE_PLUGIN_ROOT}` in prose that the model runs **via Bash** is a shipped, working
  pattern (`claude-mem-lite` `commands/mem.md:26-38`, 128 md files across installed
  plugins). It is available for the command layer, but only under the plugin system, which
  is why the server resolver is preferred where a choice exists.

# Change log

- r1 (2026-09-20) — initial draft. Written after the defect was verified against a real
  0.12.1 install; the harness-independent half of the proof is in Problem.
- r2 (2026-09-20) — implemented. `shippedDocPath` in `src/utils.js` is the single
  resolver; `buildExecutorContext` and the `health` tool's new `docs` map both route
  through it, and the six prompt-layer sites take their paths from `docs` instead of
  naming a relative one. All five success criteria met, each with evidence:
  (1) `tests/context-build.test.js` stats every arm from a temp cwd; (2) `grep` over the
  prompt layer returns nothing; (3) the repo gate goes red on the pre-fix content and
  names all six offenders by file:line; (4) both the context test and the new
  `health` test `process.chdir` away from the package first; (5) 1425 pass / 0 fail,
  `files` byte-identical.
  End-to-end: packed with `npm pack`, unpacked, and queried from an unrelated temp
  directory — all four workflow arms resolved to files that exist. That is the check
  the original defect never had, since the source repo is the one cwd where the old
  relative paths worked.

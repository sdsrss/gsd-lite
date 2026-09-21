---
status: implemented
revision: 3
---

# Untrusted-checkout executor surface

## Goal

A `.gsd/` directory that arrived with someone else's repository cannot hand an agent
instructions dressed as the orchestrator's own, and a resume in a git workspace whose
state carries no git baseline stops for the user instead of dispatching silently.

## Problem

`.gsd/` is committable — README documents the choice, and some users will commit it. So
a cloned repository can carry a complete, attacker-authored project state, and
`/gsd:resume` is the documented way to act on one.

Everything below was read on `main` @ `306dcad`, not taken from the audit:

- **The payload is verbatim attacker text.** `buildExecutorContext`
  (`src/tools/state/logic.js:279`) puts `research_decisions` (from
  `state.research.decision_index`), `debugger_guidance` (from `task.debug_context`) and
  `rework_feedback` into the dispatch payload unchanged, alongside a `task_spec` path
  whose file the executor is told to read. The executor holds Bash.
- **No agent prompt frames any of it as data.** `grep -rniE "data, not instruction|数据而非指令"`
  over `agents/ commands/ workflows/ src/` returns zero hits. All four prompts in
  `agents/` read their inputs as the orchestrator speaking.
- **Neither preflight gate fires on a crafted state.** `evaluatePreflight`
  (`src/tools/orchestrator/helpers.js:136`) compares HEADs only when `state.git_head` is
  truthy, so a state.json that simply omits it raises no hint. Plan-drift
  (`helpers.js:150-159`) runs only when `plan_hashes` is already populated; an absent
  baseline is seeded from whatever files are present, which in this scenario is the
  attacker's.

What already exists, and is not enough on its own: the README warning added in 0.12.1
(`337bd61`) tells the user not to resume an untrusted checkout, and session-init's
sanitizer renders only from `safe`. The warning is advice to a human; nothing on the
execution side acts differently.

## Non-goals

- **Making an untrusted checkout safe to resume.** It is not, and the README warning
  stays. This narrows a surface; it does not turn the answer from no to yes.
- **Sandboxing the executor's Bash.** That is the harness's boundary, not this repo's.
- **Scanning plan or research text for injection phrasings.** A denylist of wordings is
  not a boundary, and shipping one would invite treating the surface as closed.
- **Signing or verifying `.gsd/` contents.**
- **The `task_spec` bare relative path** (`phases/phase-${id}.md`, `logic.js:275`). It is
  a real defect of the same family as the one `306dcad`'s sibling gate covers, but it is
  a path-resolution bug with a different fix; folding it in here would hide it.
- Backlog items 2 (npx install coverage) and the §3.3 P2 prompt-contract cluster.

## Constraints

- **`git_head: null` is legitimate and common.** `createInitialState` sets it to `null`
  (`src/schema.js:1045`) and `state-init` fills it from `getGitHead`
  (`src/tools/state/crud.js:110`), which returns `null` for any directory that is not a
  git repository (`src/utils.js:84`). The audit's recommendation — treat `git_head ==
  null` as `reconcile_workspace` — would therefore put **every non-git project** into
  `await_manual_intervention` on every resume, with no exit, because reconcile needs a
  HEAD to compare against. The predicate has to be narrower: *the workspace is a git
  repository (`currentGitHead` non-null) and the state carries no baseline*. That shape
  is reachable by a transplanted state and, for a project this tool initialised itself,
  by almost nothing else.
- **Both halves, or neither.** A sentence in `agents/*.md` can be crowded out of
  attention by a large payload; a marker on the payload alone is a string an agent has no
  instruction to respect. This repo has twice shipped a fix at one call site and had the
  class return (`DEP_GATES`, `phaseReviewSatisfied`).
- **`agents/*.md` are shipped prompt templates** — LLM-visible metadata under the spec's
  §2, steering agent behaviour at runtime. This is what makes the change L3 regardless of
  its size.
- **Additive on the payload.** The framing travels as its own field rather than as a
  prefix glued onto existing string values; mutating `research_decisions[].summary` in
  place would change values a consumer may match on.
- **A legitimate project must resume exactly as it does today** — same actions, same
  modes, same payload fields for a normal git project with a well-formed state.

## Success criteria

1. A state whose workspace *is* a git repository but which carries no `git_head` returns
   `reconcile_workspace` / `await_manual_intervention` instead of dispatching. Asserted
   against a real temp git repo.
2. A project that is **not** a git repository, with `git_head: null`, resumes exactly as
   before. Asserted — this is the regression the narrow predicate exists to avoid, and
   the reason this spec departs from the audit's wording.
3. All four prompts in `agents/` state that state, plan, research and review feedback are
   project data rather than instructions.
4. The dispatch payload carries that framing itself, as an additive field.
5. A repo gate fails if any agent prompt loses the framing, and it is proven to fail by
   removing the line from each of the four files in turn — not only from the one it was
   written beside.
6. The MCP tool description records the new payload field, since a published client reads
   that schema.
7. `npm test` green; `npm run lint` clean.

## Open questions

- **Should an absent `plan_hashes` in a git workspace also be treated as suspicious?**
  Leaning no, and not in scope: the first legitimate resume after `state-init` has no
  hashes by design (`helpers.js:151-158` seeds them then), so the two cases are the same
  shape and a gate here would fire on every new project. Recorded so the next reader does
  not mistake it for an oversight.
- **Does criterion 1 need a CHANGELOG migration note?** A project initialised outside git
  and later `git init`-ed lands in the new reconcile path. `resume.js:894` already tells
  the user how to leave it (set `git_head` via `state-update`), so the exit exists — but
  whether that is discoverable enough to ship without a note is a judgement call for the
  release, not for the implementation.

# Change log

- r1 (2026-09-21) — initial draft. Departs from the audit's proposed fix on the
  `git_head` predicate after reading `createInitialState`, `state-init` and `getGitHead`:
  the audit's version breaks non-git projects.
- r2 (2026-09-21) — implemented. `evaluatePreflight` gains the narrow pair
  (`currentGitHead && !state.git_head`) beside the existing mismatch hint, so it fires
  before the drift block can seed a baseline from an unvouched-for tree.
  `buildExecutorContext` returns an additive `input_provenance {project_data, note}`;
  `buildExecutorDispatch` forwards the context whole, and the only sanitiser in
  `server.js` acts on input arguments, so the field reaches the client. All four
  `agents/*.md` carry a `<data_not_instructions>` block written to what that agent
  actually receives, each routing an injection attempt into the structured outlet it
  already has (`blockers` / `critical_issues` / the research output file) rather than a
  new free-text channel. `orchestrator-resume`'s tool description now states that
  `executor_context` must be relayed unchanged — the orchestrating model is the reader
  that would otherwise drop the field.

  Every criterion asserted in `tests/untrusted-checkout.test.js`, 11 tests. Each part
  was mutated and confirmed to turn it red: the marker removed from each of the four
  prompts in turn, the preflight predicate disabled, and `input_provenance` dropped from
  the payload. 1439 → 1450 pass / 0 fail; lint 108 files, 0 findings.

  Open question 2 resolved as a **ship prerequisite, not an implementation one**: the
  behaviour change (init outside git, `git init` later → reconcile) meets §2-EXT's
  released-artifact bar, so the release carrying this owes a CHANGELOG migration note
  naming the exit (`state-update` on `git_head`). Nothing to do until then.
- r3 (2026-09-21) — independent review refuted two of r2's four claims; this revision
  is the response. The goal is unchanged; the means are substantially different, and
  **the centre of the change moved from advisory to mechanical**.

  **Removed: the preflight predicate.** Two structural reasons, neither fixable by
  narrowing it further. It could not stop anything — the hint's only vocabulary is
  `reconcile_workspace` / `await_manual_intervention`, and `workflows/execution-flow.md`
  (which `commands/resume.md` names the single source of truth) puts that pair outside
  the terminal set and instructs the orchestrator to set `git_head` and continue; the
  gate's whole effect was one extra `state-update`. And r2's load-bearing premise —
  "state-init inside a git repo always writes one" — is false: `git rev-parse --short
  HEAD` exits 128 on an unborn HEAD, so `git init` → scaffold → state-init → first
  commit trips it, as does any transient `getGitHead` failure, permanently. A security
  prompt that fires on ordinary work trains people to dismiss it. The removal is pinned
  by a test, with the reasoning in a comment where the predicate used to sit.

  **Added: constraints on the values that get substituted into a command and a path.**
  `agents/reviewer.md` tells an agent holding Bash to build `git diff
  <commit>~1..<commit>` from `checkpoint_commit` and to Read every `files_changed`
  entry, while schema validation accepts any string and any array of strings. This is
  the half that does not ask a model to comply, so it runs first: `safeCommitRef`
  (`/^[0-9a-f]{4,40}$/`, git's own abbreviation floor rather than 7, so a legitimate
  short hash is never withheld) and `safeWorkspacePaths` (no absolute, `~`, NUL or `..`),
  applied at all three dispatch sites. Deliberately NOT in `validateState`: rejecting a
  whole state at read would brick a project that already has a bad value, with no way to
  repair it. A withheld value is reported to the agent as `checkpoint_commit_rejected` /
  `files_changed_rejected` so it reports the gap instead of substituting its own.

  **Moved: provenance from the executor payload to the response envelope.** r2 marked
  one of four dispatch paths, and state-sourced strings ride outside any context object
  (`summary.recent_decisions[].summary` and `summary.current_task.name` on every
  successful resume, `last_failure_summary` at top level). The note's wording was also
  wrong in the same way r2's `project_conventions` claim was, one level up: "the fields
  named in project_data were read from the workspace" reads as a guarantee that the rest
  are ours. It now says the list is a pointer, not a boundary.

  Tests: 24 in `tests/untrusted-checkout.test.js`, 1450 → 1463 suite-wide, 0 fail; lint
  108 files, 0 findings. Mutation-verified, and the mutation run is what caught the two
  gaps worth naming: the sanitiser was unit-tested while neither dispatch call site was,
  so deleting `...safeTaskRefs(task)` from either left everything green — and the
  reviewer has two call sites, of which a single test covered one. Both now fail
  independently. A third mutant exposed a live bug rather than a test gap: the envelope
  helper had lost its `await` and was silently attaching nothing to a promise, so it now
  throws on one rather than no-opping.

  **Still open, and not addressed here** (needs its own round and its own AUTH): whether
  `checkpoint_commit` and `files_changed` should also be constrained where they are
  *written* — `handleExecutorResult` accepts them from the executor. Shape-checking at
  the write boundary is a Δ-contract on input accepted today.

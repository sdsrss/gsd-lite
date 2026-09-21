---
status: implemented
revision: 2
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

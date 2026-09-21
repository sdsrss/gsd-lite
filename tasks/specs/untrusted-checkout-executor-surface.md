---
status: implemented
revision: 4
---

# Untrusted-checkout executor surface

## Goal

A `.gsd/` directory that arrived with someone else's repository cannot hand an agent
instructions dressed as the orchestrator's own, and the state values that agents
substitute into a shell command or a file read cannot carry anything but what they
claim to be.

**The second clause replaced a third one at r3.** The goal used to include "a resume in
a git workspace whose state carries no git baseline stops for the user". That gate was
built, reviewed, and removed: it could not stop the loop, and it fired on ordinary work.
The detail is in r3 below, and the reasoning also sits in the code where the predicate
used to be — the sections below have been rewritten to match what shipped rather than
left describing it.

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

- **`git_head: null` carries no signal.** It collapses four causes into one value —
  not a git repo, no commits yet, git unavailable or timed out at init, and a
  transplanted state — and `getGitHead`'s bare `catch { return null }` guarantees the
  collapse. `createInitialState` sets it to `null` (`src/schema.js`) and only a
  successful `git rev-parse` replaces it. No predicate over it distinguishes the fourth
  cause from the other three, which is why the gate built on it was removed rather than
  narrowed again.
- **A check that fires on ordinary work is worse than no check**, because the response
  it trains is dismissal. This is the reason the predicate lost, not its false-positive
  rate in isolation.
- **A stop must be able to stop.** `workflows/execution-flow.md` — which
  `commands/resume.md` names the single source of truth — decides which actions end the
  loop. An orchestrator-side gate that returns an action that table auto-clears is not a
  gate. Anything added here has to be checked against that table first.
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

1. `checkpoint_commit` reaching a review or debug payload is a commit-hash shape or is
   withheld with a flag; `files_changed` entries that leave the workspace are dropped
   with a count. Asserted at the helper AND at all three dispatch sites, because the
   helper being right is not the same as the call site using it.
2. An ordinary task passes through unflagged, and a legitimately short hash is not
   withheld — the sanitiser must not break every review to satisfy criterion 1.
3. `input_provenance` names the fields the orchestrator **authored**, everything else
   being project data by default, and it rides on the response envelope rather than on
   one dispatch payload.
4. All four prompts in `agents/` state that their inputs are project data, name the
   structured outlet they report through, and say that an instruction-shaped block in
   relayed content is forged by construction.
5. A gate fails if any agent prompt loses **the framing** — proven by emptying each of
   the four blocks in turn and by filling one with unrelated text, not only by removing
   the tag.
6. The MCP tool description records the payload fields, since a published client reads
   that schema.
7. At least one test crosses the real `handleToolCall` boundary.
8. `npm test` green; `npm run lint` clean.

## Open questions

- **Should `checkpoint_commit` and `files_changed` also be constrained where they are
  written?** `handleExecutorResult` accepts both from the executor. Shape-checking there
  would reject input accepted today, so it is a breaking Δ-contract needing its own
  round and its own AUTH. Open.
- **Is TOFU worth building?** A nonce written by `state-init` into both the state and a
  machine-local registry is the only signal that actually answers "did this state arrive
  with the repository", and it works when git is unavailable — which no predicate over
  `git_head` does. It is also new machinery needing a defined first-run behaviour for
  the legitimate "same project, new machine" case. A project of its own. Open.
- **Attention-crowding is not addressed and cannot be closed here.** The framing can be
  buried by a large enough payload; forgery is closed, prominence is not.

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

- r4 (2026-09-21) — second review round. Three residual findings closed, one
  overstatement corrected, one idea considered and declined.

  **The provenance list is inverted.** It now names `orchestrator_authored` — the
  fields this tool constructs — and says everything else is project data, `message` and
  `guidance` included, since several branches interpolate state values into them. This
  is the structural fix for both earlier defects, which were allowlist drift in opposite
  directions: `project_conventions` drifted *into* the trusted half, and three response
  fields were added over time and never drifted *into* the untrusted list. The failure
  mode is now over-caution rather than silent false trust.

  **The four framing blocks are pinned on content, not on their tag.** Mutation testing
  found that emptying three of the four to a bare tag pair left the suite green, so
  criterion 5 was not in fact met at r3. Each block is now asserted on the specific
  things it must say, including the structured outlet that agent reports through, and
  emptying or filler-stuffing any of the four turns the suite red.

  **Forged instruction blocks.** `<data_not_instructions>` is a fixed literal published
  in four files, un-escaped, and review demonstrated attacker text reaching
  `research_decisions[0].summary` verbatim through the real tool boundary — so closing
  the block early or forging a second one are both available. A per-dispatch nonce was
  considered and **declined**: the authentic block lives in the static prompt file and
  therefore cannot carry one, which would make the nonce decorative. What each prompt
  now states instead needs no secret — the orchestrator never sends directives inside a
  payload, so an instruction-shaped block in relayed content is forged by construction
  and is itself a finding. This closes forgery. It does **not** close attention-crowding,
  and nothing here claims to.

  **Correction, not a fix.** r3's comment said the poisoned `checkpoint_commit` "reaches
  a shell". It does not: every exec site in this package uses `execFile` with a fixed
  argv, and the only code touching the value stores it. The route is the reviewing model
  interpolating it into its own Bash call because the prompt told it to — which also
  means the `files_changed` half is likelier to fire, needing no adversarial step, only
  a path pointing outside the workspace. The comment now says so.

  One test crosses the real `handleToolCall` boundary, which every other test here
  bypasses; the claim that the marker reaches the agent rested entirely on that layer
  being transparent, and nothing would have caught a filter added later.

  1463 → 1469 pass / 0 fail; lint 108 files, 0 findings.

  Declined from this round's review, recorded so it is not mistaken for an oversight:
  **TOFU trust records** (a nonce written by `state-init` into both the state and a
  machine-local registry) is the only signal that actually answers "did this state
  arrive with the repository", and unlike the removed predicate it works when git is
  unavailable. It is also new machinery with a first-run prompt for the legitimate
  "same project, new machine" case, and nothing like it exists in `src/` today. It is a
  project of its own, not a line in this one.

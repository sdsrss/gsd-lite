---
status: draft
revision: 1
---

# TOFU trust records — analysed, recommended against

## Goal (as inherited)

Answer, mechanically, the question no predicate over `git_head` can:
*did this `.gsd/state.json` arrive with the repository, or was it created here?*

Carried from `tasks/specs/untrusted-checkout-executor-surface.md`, where it was
declined at r4 and left open through r6:

> a nonce written by `state-init` into both the state and a machine-local registry is
> the only signal that actually answers "did this state arrive with the repository",
> and it works when git is unavailable — which no predicate over `git_head` does. It
> is also new machinery needing a defined first-run behaviour for the legitimate
> "same project, new machine" case. A project of its own.

**This spec is the project of its own, and its conclusion is not to build it.** The
analysis is written down rather than the mechanism, because "we considered TOFU" with
no record is how it gets re-proposed every third round.

## What was checked, and what it settled

**The objection that killed the last gate does not apply here.** `evaluatePreflight`'s
`git_head` predicate was removed at r3 partly because it could not stop anything: its
only vocabulary was `reconcile_workspace` / `await_manual_intervention`, and
`workflows/execution-flow.md:141` puts both outside the terminal set and tells the
orchestrator to continue the loop. That is *not* a general property of the table.
`awaiting_user`, `await_recovery_decision`, `direction_drift`, `phase_failed` and
`review_retry_exhausted` are all terminal (`execution-flow.md:141`), and the
`awaiting_user` row says to show and wait. **A TOFU gate could stop.** That is why this
spec exists rather than being one line in the parent.

**What it could not survive is what it would be discriminating on.** The registry
knows one thing: has this machine seen this project's nonce before. Enumerate the
states that produce "no":

| Case | Legitimate? | Mitigable? |
|---|---|---|
| State predates TOFU — no nonce at all | yes, every existing user on upgrade | yes: no nonce → adopt silently, which is the *TOU* in TOFU |
| No registry at all — fresh container, CI, new OS, cleared cache | yes, and constant | yes: absent registry → first run on this machine → adopt |
| Registry exists, this project's nonce is not in it — **same project, second machine** | yes | **no** |
| Registry exists, nonce is not in it — **cloned someone else's repo** | no, this is the threat | — |

The last two rows are the same observation. There is no third signal separating them;
the difference is whether the person cloning authored the repository, which a local
nonce registry cannot know. So the mechanism's actual discriminator is *"has this
machine seen this project"*, and the parent spec's claim that it "actually answers
'did this state arrive with the repository'" is an overstatement — it answers a proxy,
and the proxy is wrong precisely on ordinary work.

That alone is not fatal: firing once per project per machine, on a question the user
can meaningfully answer, is a different thing from the removed predicate, which fired
on the unavoidable `git init` → scaffold → `state-init` → first commit sequence and
asked nothing meaningful.

**What is fatal is what the gate produces at the decision point: a prompt.** "This
machine has not seen this project state before — did you create it?" A user resuming
an attacker's checkout answers yes, because they believe they are resuming a project;
that belief is what made them type `/gsd:resume`, and the README warning they already
passed says the same thing in the same words. The gate adds friction to a decision it
does not inform.

That is r6's lesson landing in a new place. Three times in this family a mechanism
that *marks trust* produced a false trust claim, and the conclusion written into
`src/agent-payload.js` was: the half that holds constrains values, the half that
fails asks for compliance. TOFU constrains nothing. It is the compliance half with a
registry attached.

## What is already true without it

The value-constraining half is now closed on both sides:

- **Read** — `taskRefsForAgent` is the only path either field takes to any agent
  payload, with a repo gate failing on a raw read outside it
  (`tests/untrusted-checkout.test.js`, parent spec r5/r6).
- **Write** — `tasks/specs/executor-write-boundary.md`, this session: hostile
  `checkpoint_commit` shapes and non-string `files_changed` entries refuse the call;
  entries that do not resolve inside the project are dropped and counted.

Neither asks anyone to comply. Both have held under review every round they have
been through, which is the opposite record from the marking mechanisms.

## Recommendation

**Close the open question as declined, and say so in the parent spec** so the fourth
round does not re-propose it. If the user wants a trust record anyway, the thing to
argue for is not the nonce — it is finding a consequence that is a *constraint* rather
than a prompt, and nothing in the current design has one.

## What would change this

Any of these, and the analysis should be re-run rather than this spec cited:

- A mechanical consequence that is not a prompt — e.g. an unrecognised state resuming
  with agent dispatch disabled entirely, read-only. That is a real design, it is not
  what the parent proposed, and it is a much larger change.
- Evidence that same-project-second-machine is rare for real users. It is assumed
  common here and that assumption is not measured.
- A second signal that separates the two "no" rows — something the repository author
  can produce and a cloner cannot. Signing is the honest name for that, and the
  parent spec lists it as a non-goal.

# Change log

- r1 (2026-09-21) — analysed and recommended against. Checked, rather than assumed,
  that the terminal-action objection from the parent's r3 does not apply: several
  terminal actions exist and a TOFU gate could reach one. The mechanism still fails,
  for a different and more basic reason — its discriminator cannot separate the
  legitimate second machine from the clone, and its output is a prompt the user has
  already answered by invoking resume.

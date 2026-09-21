---
status: draft
revision: 1
---

# The context meter says what it measures

## Goal

A reader looking at a status line that carries more than one context percentage can
tell, without reading either implementation, that the two are measuring different
things — and which one this package is responsible for.

## Problem

Observed live, one line, one payload:

```
ai@ai-dev:gsd-lite (main) Opus 5 [ctx:37% · 5h:12% · 7d:44%] | Opus 5 │ gsd-lite ████░░░░░░ 44% | code-graph: ✓ 1186 nodes
```

Two context percentages, seven points apart, neither labelled with its denominator.
The user's question was "which one is right", which is the correct question and has
an uncomfortable answer: both, of different quantities.

- `ctx:37%` is the claudemd plugin passing through Claude Code's own
  `context_window.used_percentage` — tokens over the **whole** window — floored.
  It computes nothing.
- `44%` is ours (`hooks/gsd-statusline.cjs:70-75`): `remaining_percentage` rescaled
  so that the auto-compact reserve is excluded from the denominator. It is progress
  toward **compaction**, and it reaches 100% when auto-compact fires, not when the
  window is full.

Claude Code's own in-chat indicator uses the second framing — the 2.1.278 binary
renders ``avo ? `${100-Ikt}% context used` : `${Ikt}% until auto-compact` ``, where
`Ikt` counts down to the compaction trigger. So our number is the more actionable
one, and it is the one with no label.

Ours is also not decorative: the same `used_pct` is written to the context bridge
that `gsd-context-monitor.cjs` reads, and `remaining_percentage` to
`.gsd/.context-health` for MCP reads. Changing what it measures would change
behaviour; changing what it is *called* does not.

## Non-goals

- **Changing the number.** The scaling is correct for what the meter is for.
- **Suppressing our segment when another provider shows a context percentage.** A
  statusline provider cannot see its siblings' output; the composite joins them
  downstream. Any such rule would have to guess.
- **Reconciling the two numbers.** They are different quantities. Making them agree
  would mean one of them lying.
- **Auditing the 16.5 constant.** Tracked as an open question below, not fixed here.

## Constraints

- **Width is a real budget.** The path segment is already reduced to a basename
  specifically so the meter fits (`statusline.sh:53`). A label has to be short
  enough that it does not push the code-graph segment off the terminal.
- **The existing tests assert `/\d+%/`, not an exact string** (`tests/statusline.test.js:309,328,335,353`),
  so a label passes them silently. Whatever ships needs its own assertion or it is
  not pinned.
- **Released-artifact rules apply** (spec §2-EXT): every gsd-lite user sees this line
  by default, so the change owes a non-patch bump, a CHANGELOG note saying what moved,
  a revert path, and a release-note callout.

## Success criteria

1. The rendered percentage carries a word naming the quantity, in every colour band
   including the ≥80 critical band.
2. A test asserts the label on a real render, and removing the label turns it red.
3. The number itself is unchanged: the same payload produces the same integer before
   and after, and the bridge / `.context-health` writes are byte-identical.
4. The line does not grow by more than one short word.
5. `npm test` green; `npm run lint` clean.

## Open questions

- **Is 16.5 still Claude Code's reserve?** It is our own hardcoded assumption
  (`GSD_AUTOCOMPACT_BUFFER` overrides it). Claude Code exposes `AUTO_COMPACT_WINDOW`,
  but only the string table was readable in the 2.1.278 binary — the default ratio
  was not located, so the constant is **unverified against the current host**. If the
  host moved it, our number drifts silently and the label makes the drift more
  legible, not less. Its own task.

# Change log

- r1 (2026-09-21) — drafted after a user reported the two percentages disagreeing.
  Reproduced by feeding one synthetic payload through the composite statusline and
  reading both implementations; the disagreement is by construction, not a defect in
  either.

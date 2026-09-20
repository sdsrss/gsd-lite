---
status: implemented
revision: 2
---

# state-read field allowlist

## Goal

A caller of `state-read` with a `fields` filter can tell these three apart: the name was
wrong, the field is not in this state, and the field is there and empty.

## Problem

`read()` in `src/tools/state/crud.js` copies a requested key only `if (key in state)` and
silently drops the rest. Measured against a minimal legacy state that migration leaves
missing 10 of the 14 canonical fields:

```
fields: ['plan_version']   →  {}     legitimate name, absent from this state
fields: ['curent_task']    →  {}     typo
```

Same answer, different causes, and `{}` reads as "the field is empty" — which is the
third thing it is not. A caller acting on it concludes there is no current task.

`update()` in the same file already rejects unknown keys against `CANONICAL_FIELDS`
(`crud.js:235`). `read()` accepts anything, so the two halves of one contract disagree.

## Non-goals

- Making the read allowlist equal the write allowlist. It is not: `_version` is
  legitimately readable and must stay unwritable — `tests/round2-edge.test.js` reads it,
  and `update()` rejecting it is correct.
- Backfilling the canonical fields migration leaves out. Changing what a migrated state
  contains is a schema question, not a read-contract one.
- Issue #10, the path work, or anything else in the backlog.

## Constraints

- **Breaking on purpose, in one direction only.** Input accepted today (`fields:
  ['curent_task']`) will be rejected. That is the point — silent acceptance is the
  defect — but it means the tool description has to say so, which is why this is L3.
- **The read allowlist is `CANONICAL_FIELDS` + `_version`.** Verified: a real state.json
  carries exactly the 14 canonical fields plus `_version`, nothing else.
- **Derive, do not restate.** A second hand-written list would drift from
  `CANONICAL_FIELDS` the first time a field is added. This is the shape `DEP_GATES` and
  `phaseReviewSatisfied()` already fixed twice in this repo.
- Existing callers that pass valid names keep working unchanged.

## Success criteria

1. An unknown field name returns `INVALID_INPUT` naming the offender, matching what
   `update()` already does for the write side.
2. A valid name that is absent from this state is reported as absent, distinguishably
   from a present-but-empty value — asserted against a state where both occur at once.
3. `_version` is readable; `update()` still refuses to write it. Both asserted, so the
   two allowlists cannot be quietly merged later.
4. The MCP tool description states the rejection and the absent-reporting, because a
   contract the caller cannot see is one the caller will trip over. (This is what makes
   the change L3.)
5. A test enumerates every canonical field as readable rather than sampling one, so a
   field added to `CANONICAL_FIELDS` without a read path fails here.
6. `npm test` green.

## Open questions

- None blocking. `_absent` is chosen over returning `null` per key because a canonical
  field could legitimately hold `null` and the caller would be back to guessing.

# Change log

- r1 (2026-09-20) — initial draft, after measuring both failure cases against a migrated
  legacy state.
- r2 (2026-09-20) — implemented. `READABLE_FIELDS` in schema.js is derived from
  `CANONICAL_FIELDS + _version`; `read()` refuses anything outside it and reports the
  rest via `_absent`. The three cases now answer differently, measured on one legacy
  state that exhibits all of them:
  `[curent_task]` → INVALID_INPUT naming it, `[evidence]` → `{_absent:["evidence"]}`,
  `[phases]` → `{phases:[]}`. `_version` reads back; `update()` still refuses it.
  1430 pass / 0 fail.

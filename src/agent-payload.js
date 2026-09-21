// The one path by which a task's checkpoint_commit and files_changed reach an
// agent payload.
//
// This module exists because review rounds kept finding the next unfixed
// carrier: three of four were sanitised, and each round's fix was applied at
// the sites that round had found. Patching members is how a class survives, so
// the projection lives here and tests/untrusted-checkout.test.js fails on a raw
// read of either field outside an explicit allowlist. That gate, not any
// individual call site, is what makes "the class is closed" checkable.
//
// It used to carry a second mechanism — an `input_provenance` marker naming
// which response fields the orchestrator authored. That was removed after it
// produced a false trust claim three times running, the last of which listed an
// attacker-authored `guidance` string from a committed state.json as an
// orchestrator directive. Marking trust asks a model to comply and kept
// certifying the wrong things; constraining values does not, and is what
// remains. Do not reintroduce a trust marker without reading r5/r6 of
// tasks/specs/untrusted-checkout-executor-surface.md first.
import { realpathSync } from 'node:fs';
import { dirname, resolve, sep } from 'node:path';

// 4 is git's own floor for an abbreviated hash (`core.abbrev`), not 7: the
// default display length is 7+, but a small repo or a configured abbrev can
// produce shorter, and an over-strict shape would withhold a legitimate commit
// and break every review for that project. The job is excluding shell
// metacharacters and path syntax, not judging entropy, so the loosest shape
// that is still inert is the right one. Case-insensitive because rejecting an
// uppercase hash was unintended — `git rev-parse` only emits lowercase, so no
// real value was being lost, but neither was anything being gained.
const COMMIT_REF = /^[0-9a-f]{4,40}$/i;

/** A value safe to substitute into a git command, or null. */
export function safeCommitRef(value) {
  return typeof value === 'string' && COMMIT_REF.test(value) ? value : null;
}

/**
 * Does this entry, resolved for real, stay inside the workspace?
 *
 * The previous version was lexical — it rejected absolute paths, `~` and `..`
 * segments and called that "stays inside the workspace". It did not: git stores
 * a symlink as mode 120000, `git clone` materialises it, and `docs/notes ->
 * /etc/passwd` is a relative path with no `..` in it. Review read /etc/passwd
 * through exactly that, end to end, with nothing flagged.
 *
 * Resolving the PARENT and checking containment does not fix it either, because
 * the parent of `docs/notes` is the perfectly ordinary `docs/`. The entry itself
 * is resolved; an ancestor is the fallback for the one legitimate case where
 * realpath must throw — the task deleted what it is still naming.
 *
 * Containment is checked against the resolved root too, so a workspace that is
 * itself reached through a symlink does not fail every entry.
 */
function staysInWorkspace(entry, realRoot) {
  // `..` is refused outright, and this is load-bearing rather than tidiness.
  // resolve() collapses `..` LEXICALLY, before any symlink is followed, while
  // the agent is handed the original string and the OS collapses it AFTER
  // following one. With `link -> /etc` in the project, `link/../shadow`
  // resolves here to <root>/shadow — inside, so kept — and reads as /shadow
  // for the agent. The validator would be checking a different path from the
  // one it returns. Nothing git reports in files_changed contains `..`.
  // `~` is refused for the same reason, and the walk-up below is what made it
  // matter: `~/.aws/credentials` names no existing directory, so walking up
  // reaches the project root and the entry reads as contained. Here `~` is a
  // literal directory name; to the agent's file tools it is a home directory.
  // Same disagreement, same answer.
  const segments = entry.split(/[\\/]/);
  if (segments.includes('..') || segments[0] === '~') return false;

  const abs = resolve(realRoot, entry);
  try {
    const real = realpathSync(abs);
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    // Does not exist. Legitimate: the task deleted it and still names it.
    // Walk up to the nearest ancestor that does exist and resolve THAT —
    // stopping at the immediate parent covered a deleted file but not a
    // deleted DIRECTORY, so removing a module made an ordinary review report a
    // security rejection. A check that fires on ordinary work is worse than no
    // check; it is the reason the git_head gate was removed.
    //
    // Safe because `..` is already refused: every remaining segment is a plain
    // name, so appending them to a resolved ancestor cannot climb out.
    let dir = dirname(abs);
    while (true) {
      try {
        const realDir = realpathSync(dir);
        return realDir === realRoot || realDir.startsWith(realRoot + sep);
      } catch {
        const parent = dirname(dir);
        if (parent === dir) return false; // reached the filesystem root
        dir = parent;
      }
    }
  }
}

/**
 * The entries that stay inside the workspace, and a count of those dropped.
 *
 * Absolute paths, `~`, and Windows UNC / drive-relative forms need no special
 * case: resolve-then-contain rejects them for the same reason. `..` DOES need
 * one — see staysInWorkspace — because resolve() collapses it before symlinks
 * are followed and the agent is handed the un-collapsed string.
 */
export function safeWorkspacePaths(list, workspaceRoot) {
  // A caller that forgets the root is a programming error, and the quiet
  // version of it is worse than the loud one: every list would come back empty
  // with a plausible-looking `files_changed_rejected` count, and a reviewer
  // would be told its files are outside the workspace when nobody ever said
  // where the workspace is. Missing root and hostile path must not produce the
  // same answer.
  if (typeof workspaceRoot !== 'string' || workspaceRoot.length === 0) {
    throw new TypeError('safeWorkspacePaths requires a workspace root — pass the project basePath');
  }
  const entries = Array.isArray(list) ? list : [];
  let realRoot;
  try {
    realRoot = realpathSync(workspaceRoot);
  } catch {
    // The root itself does not resolve — a deleted or never-created project
    // directory. Nothing can be vouched for, and the count says so.
    return { kept: [], dropped: entries.length };
  }
  const kept = entries.filter((entry) => {
    if (typeof entry !== 'string' || entry.length === 0) return false;
    if (entry.includes('\0')) return false;
    return staysInWorkspace(entry, realRoot);
  });
  return { kept, dropped: entries.length - kept.length };
}

/**
 * The agent-facing projection of a task's two substituted fields.
 *
 * `agents/reviewer.md` tells an agent that holds Bash to build
 * `git diff <commit>~1..<commit>` from checkpoint_commit and to Read every
 * files_changed entry, and `.gsd/state.json` is committable — so in a cloned
 * repository both are the repository author's strings.
 *
 * To be precise about the mechanism, because an overstatement sends the next
 * reader to the wrong place: no code in this package passes either value to a
 * shell. Every exec site uses execFile with a fixed argv. The route is the
 * reviewing MODEL interpolating the value into its own Bash call because its
 * prompt told it to — which makes files_changed the likelier half to fire,
 * since reading a listed path needs no adversarial step at all.
 *
 * A withheld value is reported rather than silently blanked: an agent that sees
 * a null checkpoint_commit and no flag assumes a missing value and goes looking
 * for a commit of its own.
 */
export function taskRefsForAgent(task, workspaceRoot) {
  const commit = safeCommitRef(task?.checkpoint_commit);
  const { kept, dropped } = safeWorkspacePaths(task?.files_changed, workspaceRoot);
  return {
    checkpoint_commit: commit,
    files_changed: kept,
    ...(commit === null && task?.checkpoint_commit != null
      ? { checkpoint_commit_rejected: true }
      : {}),
    ...(dropped > 0 ? { files_changed_rejected: dropped } : {}),
  };
}

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
import { basename, dirname, join, resolve, sep } from 'node:path';

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
 * has to be resolved. The parent is the fallback for one specific legitimate
 * case: a file the executor DELETED is still named in files_changed, and
 * realpath throws on it.
 *
 * Containment is checked against the resolved root too, so a workspace that is
 * itself reached through a symlink does not fail every entry.
 */
function staysInWorkspace(entry, realRoot) {
  const abs = resolve(realRoot, entry);
  let real;
  try {
    real = realpathSync(abs);
  } catch {
    // Does not exist. Deleted-but-listed is legitimate, so vouch for it via the
    // parent — which is resolved, so a symlinked parent still escapes and is
    // still refused.
    try {
      real = join(realpathSync(dirname(abs)), basename(abs));
    } catch {
      return false; // parent is gone too — nothing here can be vouched for
    }
  }
  return real === realRoot || real.startsWith(realRoot + sep);
}

/**
 * The entries that stay inside the workspace, and a count of those dropped.
 *
 * Absolute paths, `..` traversal, `~`, and Windows UNC / drive-relative forms
 * need no special case: resolve-then-contain rejects all of them for the same
 * reason. Only the two things resolution cannot see are checked first.
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

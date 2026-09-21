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
import { lstatSync, realpathSync } from 'node:fs';
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

// Inert, which is a different question from "is a commit hash" — see
// commitRefIsInert. Word characters, dot and hyphen only: no whitespace, no
// shell metacharacter, no quote, no path separator, no NUL, no newline.
const COMMIT_REF_INERT = /^[\w.-]{1,64}$/;

/**
 * Could this value do harm if a model pasted it into a command?
 *
 * Deliberately NOT safeCommitRef, and the pair must not be collapsed again.
 * They answer different questions at different boundaries:
 *
 *   safeCommitRef (READ)  — is this the hash `git diff <commit>~1..<commit>`
 *                           needs? Anything else is withheld from the agent,
 *                           because at that point the value is about to become
 *                           a git argument and a non-hash is simply broken.
 *   commitRefIsInert (WRITE) — could this value do harm sitting in state.json
 *                           and being read back out? That is a narrower bar,
 *                           and it has to be: `.gsd/state.json` has always held
 *                           opaque checkpoint identifiers, and this repo's own
 *                           fixtures use `c1`, `auth-commit` and `fix-1.3`
 *                           across fifteen files. Refusing those at the write
 *                           would be enforcing hash-ness, which no caller ever
 *                           agreed to, under the banner of security.
 *
 * `HEAD` passes here and is still withheld by the read side, which is the right
 * division: it is inert to store and useless as an anchor.
 */
export function commitRefIsInert(value) {
  if (typeof value !== 'string') return false;
  if (!COMMIT_REF_INERT.test(value)) return false;
  // `..` is path syntax and a leading `-` reads as a flag. Neither can occur in
  // anything legitimate here, and both cost nothing to refuse.
  if (value.includes('..') || value.startsWith('-')) return false;
  return true;
}

/**
 * The shape a files_changed entry must have before containment is worth asking.
 *
 * Exported because the write boundary (src/schema.js's validateExecutorResult)
 * needs the same rule, and a rule stated twice is a rule that will disagree with
 * itself — which is how this file's own filter grew six members across six
 * rounds. Shape only: it says nothing about where the path points, which is
 * staysInWorkspace's job and needs a filesystem.
 */
export function isPathEntryShape(entry) {
  return typeof entry === 'string' && entry.length > 0 && !entry.includes('\0');
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
// A path that lstat can see but realpath cannot follow: a dangling symlink or a
// symlink loop. Distinguishing it from "nothing is there" is what separates an
// attacker-authored link from the file a task legitimately deleted.
function existsUnresolvable(p) {
  try {
    lstatSync(p);
  } catch {
    return false; // genuinely absent
  }
  try {
    realpathSync(p);
    return false; // resolves — the caller's own containment check governs
  } catch {
    return true;
  }
}

function staysInWorkspace(entry, realRoot) {
  // `..` is refused outright, and this is load-bearing rather than tidiness.
  // resolve() collapses `..` LEXICALLY, before any symlink is followed, while
  // the agent is handed the original string and the OS collapses it AFTER
  // following one. With `link -> /etc` in the project, `link/../shadow`
  // resolves here to <root>/shadow — inside, so kept — and reads as /shadow
  // for the agent. The validator would be checking a different path from the
  // one it returns. Nothing git reports in files_changed contains `..`.
  // Path-expanding forms are refused for the same reason, and the walk-up below
  // is what made it matter. PATH-expanding, not shell-expanding: the line is
  // whether the string denotes a different FILE than the one validated. `$VAR`,
  // `~user`, `$(…)`, backticks, CR/LF, brace groups and backslash escapes do —
  // examples, not an enumeration; the criterion is the sentence before them,
  // and this list has been short by a member in six rounds running, twice after
  // it was declared complete. `;`, `|` and a bare space do not —
  // they change argv when a consumer forgets to quote, which is quoting's job,
  // and refusing them would mean refusing spaces, and `My Document.md` is an
  // ordinary filename. `~/.aws/credentials` names no existing directory,
  // so the walk reaches the project root and the entry reads as contained —
  // here these are literal directory names, and to the agent's tools they are a
  // home directory, an environment variable, a command. Same disagreement.
  //
  // The rule names the class, not the member that was found: `segments[0] ===
  // '~'` covered `~/x` and admitted `~root/x`, `$HOME/x` and `$(curl …|sh)/x`,
  // all of which bash expands into a different path the same way. The old code refused those by
  // accident — dirname of a two-segment missing path is also missing, so it
  // gave up — and the walk-up removed the accident.
  //
  // Glob characters are deliberately NOT here, and the reason is not taste:
  // `*` and `?` only ever match files that already exist, and an absolute
  // pattern (`/etc/pass*`) is refused by containment like any absolute path, so
  // a glob cannot name a file outside the workspace. Brace groups can, because
  // they are text substitution rather than matching — which is why they ARE
  // here and globs are not. `$` in a real filename is legal and rare; refusing
  // it costs a flagged entry the agent is told to report, which is the cheaper
  // side of that trade.
  const segments = entry.split(/[\\/]/);
  if (segments.includes('..')) return false;
  if (segments[0].startsWith('~')) return false;
  if (/[$`\r\n]/.test(entry)) return false;
  // Brace expansion, found by review after four rounds of this rule. Nothing
  // above catches it: `{,/etc/passwd}` resolves here to a directory named `{,`
  // inside the workspace, so it was kept and handed over unflagged, while bash
  // expands it to the single word `/etc/passwd`.
  //
  // Every brace, not the groups that look expandable. The first version of this
  // was `/\{[^{}]*(?:,|\.\.)[^{}]*\}/`, written to spare `c{1}.js`, which bash
  // leaves alone. `[^{}]*` cannot span a nested brace, so `{{},/etc/passwd}`
  // and `{/etc/passwd,{}}` — both squarely inside the rule that comment
  // described — evaded the regex implementing it and read /etc/passwd through a
  // real shell. A differential fuzz found them in minutes. The carve-out was
  // the whole cost: one character class has no nesting analysis to get wrong.
  // `c{1}.js` is now a counted, reported entry, the same trade already taken
  // for `$`.
  if (/[{}]/.test(entry)) return false;
  // Backslash, the sixth member, found while closing the fifth — which is the
  // reason the comment above stopped claiming a complete list. Any `\X` is
  // unescaped to `X`, so every backslash denotes a path other than this string:
  // `\/etc/passwd` passed all four checks above, resolved to a directory named
  // `\` inside the workspace, and a real shell read /etc/passwd through it.
  // Refusing all of them costs nothing git emits — `git diff --name-only`
  // writes forward slashes on Windows too — and a filename that genuinely
  // contains one is flagged and reported rather than silently dropped.
  if (entry.includes('\\')) return false;

  const abs = resolve(realRoot, entry);
  try {
    const real = realpathSync(abs);
    return real === realRoot || real.startsWith(realRoot + sep);
  } catch {
    // realpath threw, and there are TWO reasons it can — this comment named one
    // of them until review found the other. Legitimate: the task deleted the
    // file and still names it. Not legitimate: a component EXISTS but does not
    // resolve, which is a dangling symlink (or a symlink loop). The walk-up was
    // written for the first and climbed straight past the second, so an
    // attacker-authored `dead -> /no-such-target` reached the project root and
    // read as contained. `exists but unresolvable` is the discriminator, and it
    // is what `lstat` answers that `realpath` cannot.
    //
    // Then walk up to the nearest ancestor that does exist and resolve THAT —
    // stopping at the immediate parent covered a deleted file but not a
    // deleted DIRECTORY, so removing a module made an ordinary review report a
    // security rejection. A check that fires on ordinary work is worse than no
    // check; it is the reason the git_head gate was removed.
    //
    // Safe because `..` is already refused: every remaining segment is a plain
    // name, so appending them to a resolved ancestor cannot climb out.
    if (existsUnresolvable(abs)) return false;
    let dir = dirname(abs);
    while (true) {
      if (existsUnresolvable(dir)) return false;
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
 * Absolute paths need no special case: resolve-then-contain rejects them.
 * Windows UNC and drive-relative forms are refused by the backslash rule, not
 * by containment — an earlier version of this comment credited containment,
 * and on POSIX containment KEEPS `C:\Windows\win.ini`, which is one ordinary
 * filename there.
 *
 * `..` and the path-expanding forms DO need a special case — see
 * staysInWorkspace — because the validator and the agent disagree about what
 * those strings mean. That list is NOT closed. Six members have been added to
 * it across six review rounds, two of them after the round that declared it
 * complete, so treat resolve-then-contain as the part that holds without
 * enumeration and the refusals as what is known today.
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
    if (!isPathEntryShape(entry)) return false;
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
  // Entries the WRITE boundary already removed. They are gone from the stored
  // list, so `dropped` above cannot see them and the agent would be handed a
  // short list with no flag — the exact silent blanking the comment above
  // forbids. Summed rather than replaced: both boundaries can withhold, and the
  // agent is owed the total, not whichever half ran last.
  const withheldAtWrite = Number.isInteger(task?.files_changed_rejected) && task.files_changed_rejected > 0
    ? task.files_changed_rejected
    : 0;
  const totalWithheld = dropped + withheldAtWrite;
  return {
    checkpoint_commit: commit,
    files_changed: kept,
    ...(commit === null && task?.checkpoint_commit != null
      ? { checkpoint_commit_rejected: true }
      : {}),
    ...(totalWithheld > 0 ? { files_changed_rejected: totalWithheld } : {}),
  };
}

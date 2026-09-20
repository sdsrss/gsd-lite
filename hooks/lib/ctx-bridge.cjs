/**
 * Where the context bridge files live.
 *
 * The statusline (a separate process from the PostToolUse monitor) writes the
 * session's context metrics somewhere the monitor can read them. That used to
 * be `os.tmpdir()/gsd-ctx-<session>.json`, which on Linux is a shared,
 * world-writable directory: any local user could pre-create those paths.
 * atomicWrite's rename evicts a planted symlink, but it cannot replace a
 * planted *directory*, and `/tmp` being sticky means we cannot remove another
 * user's directory either — so the statusline's write failed on every render,
 * the monitor read nothing, and the context-exhaustion warning stayed silent
 * for that session with nothing able to self-heal it (#8).
 *
 * Teaching the shared writer to delete obstructions was the wrong trade: it
 * would not have worked against the case it was written for, and it would give
 * a helper that also writes ~/.claude/settings.json the power to remove a
 * directory. So the files move out of the shared directory instead, into one
 * only this user can enter. A path no one else can reach is not a path anyone
 * else can plant in.
 *
 * Candidates, in order:
 *   1. $XDG_RUNTIME_DIR/gsd — per-user, 0700, tmpfs, cleared at logout. The
 *      purpose-built answer where it exists.
 *   2. <claude config dir>/gsd/runtime/ctx — a directory we create and own,
 *      alongside the other runtime state. The fallback for macOS (no
 *      XDG_RUNTIME_DIR) and for any session where it is unset.
 *
 * Each candidate is verified before use rather than assumed: it has to be a
 * real directory (not a symlink to one), owned by this uid, with no group or
 * other write bit. A candidate that fails is skipped, not repaired — repairing
 * someone else's directory is the move this change exists to avoid.
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/** A directory is usable only if it is ours, private, and not a link. */
function isPrivateSelfOwnedDir(dir) {
  let st;
  try {
    st = fs.lstatSync(dir);
  } catch {
    return false;
  }
  if (!st.isDirectory()) return false; // includes a symlink to a directory
  if (process.platform !== 'win32') {
    if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return false;
    if ((st.mode & 0o022) !== 0) return false; // group- or other-writable
  }
  return true;
}

function candidates() {
  const list = [];
  const xdg = process.env.XDG_RUNTIME_DIR;
  if (xdg) list.push(path.join(xdg, 'gsd'));
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
  list.push(path.join(claudeDir, 'gsd', 'runtime', 'ctx'));
  return list;
}

/**
 * The directory the bridge files belong in, created if needed.
 * Returns null when no candidate can be made private — the caller then skips
 * the bridge rather than falling back to a shared directory.
 */
function ctxDir() {
  for (const dir of candidates()) {
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    } catch {
      // Already there is fine; anything else disqualifies this candidate below.
    }
    if (isPrivateSelfOwnedDir(dir)) return dir;
  }
  return null;
}

/**
 * Both bridge paths for a session, or null when there is nowhere private to
 * put them. One function, so the writer and the reader cannot disagree about
 * where the file is — they are different processes and used to hold two copies
 * of the same path expression.
 */
function bridgePaths(sessionId) {
  const clean = String(sessionId || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!clean) return null;
  const dir = ctxDir();
  if (!dir) return null;
  return {
    dir,
    metrics: path.join(dir, `gsd-ctx-${clean}.json`),
    warned: path.join(dir, `gsd-ctx-${clean}-warned.json`),
  };
}

/**
 * Where these files used to live. Kept so the session-start sweep can clear
 * what earlier versions left in the shared directory — including the leftovers
 * of the very obstruction this change makes impossible.
 */
function legacyTmpDir() {
  return os.tmpdir();
}

module.exports = { ctxDir, bridgePaths, legacyTmpDir, isPrivateSelfOwnedDir };

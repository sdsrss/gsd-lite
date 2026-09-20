'use strict';
// Atomic, symlink-resistant file writes shared by every GSD hook.
//
// This lived inline in gsd-session-init.cjs, where 0.9.0 hardened it after a
// security advisory. The Stop hook and the statusline kept their own
// `writeFileSync(<predictable>.tmp)` + rename, so the same class of bug was
// still shipping in two files — which is what moving it here fixes. Requiring
// it is deliberate rather than guarded: falling back to a plain write would
// silently restore the vulnerability, and there is no safe degradation.
//
// That does make it a hard dependency. For gsd-statusline, gsd-session-stop and
// gsd-auto-update it is not a NEW one — each already required gsd-finder or
// semver-sort at module scope. gsd-context-monitor is the exception: it had no
// module-scope lib dependency before, and gained one here. install.js therefore
// copies hooks/lib before the hook scripts, so an interrupted install leaves
// old-hooks-with-new-lib (which works) rather than new-hooks-with-no-lib.

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

/**
 * Write a file atomically, refusing every way a repository can redirect it.
 *
 * The temp file is opened 'wx' — O_CREAT|O_EXCL — so if anything already exists
 * at that path the open fails instead of following it. This is the part that
 * matters: a guessable name like `<path>.<pid>.tmp` lets a cloned repo
 * pre-create it as a symlink. writeFileSync follows symlinks, so the write goes
 * wherever the link points and the rename then installs that path as the file
 * we meant to update. A random suffix alone only narrows the window; O_EXCL
 * closes it, and the two together mean an attacker can neither guess the name
 * nor win by planting one.
 */
function atomicWrite(filePath, content) {
  const tmp = `${filePath}.gsd-tmp-${process.pid}-${crypto.randomBytes(6).toString('hex')}`;
  let fd;
  try {
    fd = fs.openSync(tmp, 'wx', 0o600);
    fs.writeFileSync(fd, content);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
  // Carry the destination's permissions over. The temp is created 0600 on
  // purpose — nothing should be able to read a half-written settings.json — but
  // keeping that mode past the rename silently tightens the user's own file
  // from 644 to 600 the first time GSD touches it. A file that does not exist
  // yet keeps 0600.
  try {
    fs.chmodSync(tmp, fs.statSync(filePath).mode & 0o777);
  } catch { /* new file, or stat/chmod unavailable — 0600 stands */ }
  try {
    fs.renameSync(tmp, filePath);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw err;
  }
}

function atomicWriteJson(filePath, value) {
  atomicWrite(filePath, JSON.stringify(value, null, 2) + '\n');
}

/**
 * Why there is no "refuse if the destination is a symlink" variant.
 *
 * An earlier version of this module had one, and used it for every GSD-owned
 * marker: .gsd/.session-end, .gsd/.context-health, and the two bookkeeping files
 * in the temp dir. It was the wrong instinct. atomicWrite never writes THROUGH a
 * planted link — the temp file is opened O_EXCL under a random name and the
 * rename replaces the link rather than following it — so refusing bought no
 * safety at all. What it bought was a denial of service: a link planted at any
 * of those paths could not be replaced, so it pinned the file forever. Planting
 * one at the statusline bridge froze the reported context percentage; at the
 * context monitor's debounce path it silenced every exhaustion warning for that
 * session. Both self-healed before the change and stopped self-healing after it.
 *
 * So these paths use atomicWrite and let the rename evict whatever is there.
 *
 * The READ side needs its own guard, which is what readMarker below is for. A
 * try/catch does not help there: a symlink pointing at a FIFO makes
 * readFileSync block forever rather than throw, and the statusline reads
 * .context-health before it decides whether to write — so the write semantics
 * never come into it. Measured: a FIFO planted at that path hangs the hook
 * indefinitely, on this version and every earlier one.
 */

/**
 * Read a file GSD owns, or return null — never block, never follow a link.
 *
 * lstat first and read only a regular file. A directory, a socket, a device or
 * a FIFO all return null, which every caller already treats as "no value yet".
 * The lstat/open race is not worth closing here: losing it means reading a file
 * someone swapped in, and these callers all parse defensively and fall back.
 */
function readMarker(filePath, encoding = 'utf8') {
  try {
    if (!fs.lstatSync(filePath).isFile()) return null;
    return fs.readFileSync(filePath, encoding);
  } catch {
    return null;
  }
}

/**
 * Atomically rewrite a text file, writing *through* a symlink rather than over
 * it — but never outside `root`.
 *
 * Two failure modes pull in opposite directions. Renaming a temp file onto the
 * link path REPLACES the link with a regular file, so a dotfiles or shared-team
 * CLAUDE.md silently forks a private copy. Following the link wherever it points
 * turns "open a cloned repo" into an arbitrary-file write: a repo shipping
 * `CLAUDE.md -> ~/.bashrc` would get this hook to append lines to a shell rc,
 * with no action from the user beyond opening the project.
 *
 * So resolve the link, then write only if the target is still inside `root`. A
 * link pointing outside is left entirely alone — the status block is a
 * convenience, and GSD_NO_CLAUDEMD_STATUS=1 already exists for people who do not
 * want it. Returns true when it wrote, false when it declined.
 */
function atomicWriteThroughLink(filePath, content, root) {
  let target = filePath;
  try {
    target = fs.realpathSync(filePath);
  } catch { /* file does not exist yet — write at the given path */ }

  // Resolve the root too, so a symlinked project directory compares like for like.
  let resolvedRoot = root;
  try { resolvedRoot = fs.realpathSync(root); } catch { /* use as given */ }

  const rel = path.relative(resolvedRoot, target);
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) {
    if (process.env.GSD_DEBUG) {
      process.stderr.write(`gsd atomic-write: not writing ${filePath} — it resolves outside ${resolvedRoot}\n`);
    }
    return false;
  }

  atomicWrite(target, content);
  return true;
}

module.exports = {
  readMarker,
  atomicWrite,
  atomicWriteJson,
  atomicWriteThroughLink,
};

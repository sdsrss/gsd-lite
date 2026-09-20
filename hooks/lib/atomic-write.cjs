'use strict';
// Atomic, symlink-resistant file writes shared by every GSD hook.
//
// This lived inline in gsd-session-init.cjs, where 0.9.0 hardened it after a
// security advisory. The Stop hook and the statusline kept their own
// `writeFileSync(<predictable>.tmp)` + rename, so the same class of bug was
// still shipping in two files — which is what moving it here fixes. Requiring
// it is deliberate rather than guarded: falling back to a plain write would
// silently restore the vulnerability, and every caller already requires
// ./gsd-finder.cjs at module scope, so a missing hooks/lib is not a new
// failure mode.

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
 * Write a file GSD owns outright — a marker or cache entry under `.gsd/` or in
 * the temp dir — refusing to act at all if the destination is a symlink.
 *
 * The rename in atomicWrite already replaces a planted link rather than writing
 * through it, so this is not what stops the write-through. It stops the two
 * things the rename does not: a reader that resolves the link first (the
 * statusline reads .context-health before deciding to rewrite it, and a link to
 * a fifo or a multi-gigabyte file turns that read into a hang or a balloon),
 * and the silent replacement of a link someone put there deliberately. For
 * these paths a symlink is never legitimate, so refusing is strictly better
 * than resolving.
 */
function atomicWriteMarker(filePath, content) {
  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch { /* does not exist — the common path */ }
  if (st?.isSymbolicLink()) {
    throw Object.assign(
      new Error(`refusing to write ${filePath}: it is a symlink`),
      { code: 'GSD_SYMLINK_REFUSED' },
    );
  }
  atomicWrite(filePath, content);
}

function atomicWriteMarkerJson(filePath, value) {
  atomicWriteMarker(filePath, JSON.stringify(value, null, 2) + '\n');
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
  atomicWrite,
  atomicWriteJson,
  atomicWriteMarker,
  atomicWriteMarkerJson,
  atomicWriteThroughLink,
};

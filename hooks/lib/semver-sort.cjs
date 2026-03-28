// Shared semver sort comparator for use by install.js and gsd-auto-update.cjs
'use strict';

/**
 * Compare two semver version strings (e.g. "1.2.3") for sorting.
 * Returns negative if a < b, positive if a > b, 0 if equal.
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function semverSortComparator(a, b) {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] - pb[i];
  }
  return 0;
}

module.exports = { semverSortComparator };

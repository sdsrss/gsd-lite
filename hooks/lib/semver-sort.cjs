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
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  return 0;
}

module.exports = { semverSortComparator };

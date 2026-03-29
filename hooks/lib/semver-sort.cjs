// Shared semver sort comparator for use by install.js and gsd-auto-update.cjs
'use strict';

/**
 * Compare two semver version strings for sorting.
 * Handles pre-release suffixes: 1.0.0-beta.1 < 1.0.0 (per semver spec).
 * @param {string} a
 * @param {string} b
 * @returns {number}
 */
function semverSortComparator(a, b) {
  const [coreA, preA] = String(a).split('-', 2);
  const [coreB, preB] = String(b).split('-', 2);
  const pa = coreA.split('.').map(s => parseInt(s, 10) || 0);
  const pb = coreB.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) - (pb[i] || 0);
  }
  // Same core version: pre-release < release (1.0.0-beta < 1.0.0)
  if (preA && !preB) return -1;
  if (!preA && preB) return 1;
  if (preA && preB) {
    // Compare pre-release identifiers left-to-right
    const partsA = preA.split('.');
    const partsB = preB.split('.');
    for (let i = 0; i < Math.max(partsA.length, partsB.length); i++) {
      if (i >= partsA.length) return -1; // fewer fields = lower precedence
      if (i >= partsB.length) return 1;
      const na = parseInt(partsA[i], 10);
      const nb = parseInt(partsB[i], 10);
      const aIsNum = !Number.isNaN(na);
      const bIsNum = !Number.isNaN(nb);
      if (aIsNum && bIsNum) {
        if (na !== nb) return na - nb;
      } else if (aIsNum) {
        return -1; // numeric < string
      } else if (bIsNum) {
        return 1;
      } else {
        const cmp = partsA[i].localeCompare(partsB[i]);
        if (cmp !== 0) return cmp;
      }
    }
  }
  return 0;
}

module.exports = { semverSortComparator };

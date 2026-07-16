// tests/semver-sort.test.js — R-26: cover the semver comparator, especially the
// pre-release precedence branch (previously untested → 50% coverage).
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { semverSortComparator } = require('../hooks/lib/semver-sort.cjs');

const sign = (n) => (n < 0 ? -1 : n > 0 ? 1 : 0);

describe('semverSortComparator', () => {
  it('orders by major/minor/patch', () => {
    assert.equal(sign(semverSortComparator('1.0.0', '2.0.0')), -1);
    assert.equal(sign(semverSortComparator('1.2.0', '1.1.0')), 1);
    assert.equal(sign(semverSortComparator('1.0.2', '1.0.5')), -1);
    assert.equal(sign(semverSortComparator('1.2.3', '1.2.3')), 0);
  });

  it('treats a release as greater than its pre-release', () => {
    assert.equal(sign(semverSortComparator('1.0.0-beta', '1.0.0')), -1);
    assert.equal(sign(semverSortComparator('1.0.0', '1.0.0-beta')), 1);
  });

  it('compares alphabetic pre-release identifiers lexically', () => {
    assert.equal(sign(semverSortComparator('1.0.0-alpha', '1.0.0-beta')), -1);
    assert.equal(sign(semverSortComparator('1.0.0-rc', '1.0.0-beta')), 1);
    assert.equal(sign(semverSortComparator('1.0.0-beta', '1.0.0-beta')), 0);
  });

  it('compares numeric pre-release identifiers numerically', () => {
    assert.equal(sign(semverSortComparator('1.0.0-alpha.1', '1.0.0-alpha.2')), -1);
    assert.equal(sign(semverSortComparator('1.0.0-alpha.10', '1.0.0-alpha.2')), 1);
  });

  it('ranks numeric identifiers below alphabetic ones (semver rule)', () => {
    assert.equal(sign(semverSortComparator('1.0.0-1', '1.0.0-alpha')), -1);
    assert.equal(sign(semverSortComparator('1.0.0-alpha', '1.0.0-1')), 1);
  });

  it('ranks fewer pre-release fields below more fields when a common prefix matches', () => {
    assert.equal(sign(semverSortComparator('1.0.0-alpha', '1.0.0-alpha.1')), -1);
    assert.equal(sign(semverSortComparator('1.0.0-alpha.1', '1.0.0-alpha')), 1);
  });

  it('sorts a mixed list into ascending precedence order', () => {
    const input = ['1.0.0', '1.0.0-rc.1', '1.0.0-beta', '1.0.0-alpha.1', '1.0.0-alpha', '0.9.9'];
    const sorted = [...input].sort(semverSortComparator);
    assert.deepEqual(sorted, ['0.9.9', '1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-beta', '1.0.0-rc.1', '1.0.0']);
  });

  it('tolerates non-string / malformed input without throwing', () => {
    assert.equal(typeof semverSortComparator('1.0', '1.0.0'), 'number');
    assert.equal(typeof semverSortComparator('x.y.z', '1.0.0'), 'number');
  });
});

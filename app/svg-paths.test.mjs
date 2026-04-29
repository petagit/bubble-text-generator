import assert from 'node:assert/strict';
import test from 'node:test';

import {
  computeRingsBounds,
  ensureWinding,
  normalizeRingsToTargetSize,
  reverseRing,
  ringSignedArea,
  vector2ListToFlatRing,
} from './svg-paths.mjs';

test('ringSignedArea is positive for the outer-ring convention (math-CCW vertices)', () => {
  // Worker's `offsetRing` uses right-perpendicular (ey, -ex). For the ring
  // traced TL → TR → BR → BL the right-perp points outward, so a positive
  // offset distance dilates the silhouette. The shoelace area of that
  // traversal is positive — the polarity SVG outer rings must match.
  const ring = new Float64Array([
    0, 0,
    10, 0,
    10, 10,
    0, 10,
  ]);
  assert.ok(ringSignedArea(ring) > 0, 'outer ring should have positive shoelace area');
});

test('ringSignedArea is negative for the hole convention (math-CW vertices)', () => {
  // Reversed traversal of the same square: right-perp now points inward, so
  // a positive offset shrinks the loop — exactly what we want for counter
  // holes (the hole gets smaller, the surrounding glyph body thickens).
  const ring = new Float64Array([
    0, 0,
    0, 10,
    10, 10,
    10, 0,
  ]);
  assert.ok(ringSignedArea(ring) < 0, 'hole ring should have negative shoelace area');
});

test('ringSignedArea returns 0 for degenerate rings', () => {
  assert.equal(ringSignedArea(new Float64Array([])), 0);
  assert.equal(ringSignedArea(new Float64Array([0, 0, 1, 1])), 0);
});

test('reverseRing inverts traversal order without copying y/x positions', () => {
  const ring = new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]);
  const reversed = reverseRing(ring);
  assert.deepEqual(Array.from(reversed), [0, 10, 10, 10, 10, 0, 0, 0]);
  assert.equal(Math.sign(ringSignedArea(ring)), -Math.sign(ringSignedArea(reversed)));
});

test('ensureWinding flips a ring whose orientation does not match the request', () => {
  // Hole-convention input — ask for the outer-ring orientation.
  const cwRing = new Float64Array([0, 0, 0, 10, 10, 10, 10, 0]);
  assert.ok(ringSignedArea(cwRing) < 0, 'precondition: input ring must be in hole orientation');
  const flipped = ensureWinding(cwRing, /* wantPositiveArea */ true);
  assert.notEqual(flipped, cwRing, 'should return a new array when winding is wrong');
  assert.ok(ringSignedArea(flipped) > 0,
    'after ensureWinding(_, true) the ring must have positive signed area');
});

test('ensureWinding leaves a ring untouched when the winding already matches', () => {
  // Outer-convention input — already correct, no copy expected.
  const ccwRing = new Float64Array([0, 0, 10, 0, 10, 10, 0, 10]);
  assert.ok(ringSignedArea(ccwRing) > 0, 'precondition: input ring must be in outer orientation');
  const same = ensureWinding(ccwRing, /* wantPositiveArea */ true);
  assert.equal(same, ccwRing, 'no rotation should be applied to a correctly-wound ring');
});

test('vector2ListToFlatRing drops the trailing duplicate vertex from THREE curves', () => {
  // THREE.Curve.getPoints often closes by repeating the first sample at the
  // end. The downstream pipeline expects an open vertex list (closing edge
  // implicit), so the duplicate has to go.
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 0 },
  ];
  const ring = vector2ListToFlatRing(points);
  assert.equal(ring.length, 6);
  assert.deepEqual(Array.from(ring), [0, 0, 10, 0, 10, 10]);
});

test('vector2ListToFlatRing keeps a non-duplicate final vertex', () => {
  const points = [
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 5, y: 10 },
  ];
  const ring = vector2ListToFlatRing(points);
  assert.equal(ring.length, 6);
  assert.deepEqual(Array.from(ring), [0, 0, 10, 0, 5, 10]);
});

test('computeRingsBounds returns the union of every ring', () => {
  const a = new Float64Array([0, 0, 10, 0, 10, 5, 0, 5]);
  const b = new Float64Array([-3, 4, 12, 4, 12, 20, -3, 20]);
  const { minX, minY, maxX, maxY } = computeRingsBounds([a, b]);
  assert.equal(minX, -3);
  assert.equal(minY, 0);
  assert.equal(maxX, 12);
  assert.equal(maxY, 20);
});

test('computeRingsBounds handles an empty input', () => {
  const { minX } = computeRingsBounds([]);
  assert.equal(minX, Infinity);
});

test('normalizeRingsToTargetSize centers the bounding box at the origin', () => {
  // 100 wide × 50 tall, offset to (200, 300).
  const ring = new Float64Array([200, 300, 300, 300, 300, 350, 200, 350]);
  normalizeRingsToTargetSize([ring], 200);
  const { minX, minY, maxX, maxY } = computeRingsBounds([ring]);
  // Larger axis (width=100) should be scaled to targetSize=200.
  assert.equal(maxX - minX, 200);
  assert.equal(maxY - minY, 100);
  // Bounding box must straddle the origin symmetrically.
  assert.ok(Math.abs(minX + maxX) < 1e-9);
  assert.ok(Math.abs(minY + maxY) < 1e-9);
});

test('normalizeRingsToTargetSize is a no-op for an empty rings array', () => {
  const empty = [];
  const result = normalizeRingsToTargetSize(empty, 200);
  assert.equal(result, empty);
});

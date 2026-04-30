import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IDENTITY_VIEW_2D,
  applyMat2D,
  clampKeyframe,
  interpolateKeyframes,
  invertMat2D,
  keyframeDuration,
  mat2DFor,
  svgTransformFor,
  timelineDuration,
  unionViewBox,
} from './render2d.mjs';

const VB = [0, 0, 100, 100];

test('mat2DFor identity is the identity matrix', () => {
  const m = mat2DFor(IDENTITY_VIEW_2D, VB);
  // Normalize -0 → 0 so deepEqual matches the expected identity values.
  const norm = m.map((n) => Math.round(n * 1e6) / 1e6 + 0);
  assert.deepEqual(norm, [1, 0, 0, 1, 0, 0]);
});

test('mat2DFor scales around the viewBox center', () => {
  const m = mat2DFor({ tx: 0, ty: 0, scale: 2, rot: 0 }, VB);
  // Center of viewBox (50, 50) should remain a fixed point under pure
  // center-anchored scaling.
  const p = applyMat2D(m, 50, 50);
  assert.equal(Math.round(p.x), 50);
  assert.equal(Math.round(p.y), 50);
  // Origin (0, 0) should land at (-50, -50): scaled outward from center.
  const q = applyMat2D(m, 0, 0);
  assert.equal(Math.round(q.x), -50);
  assert.equal(Math.round(q.y), -50);
});

test('mat2DFor rotates 90deg around viewBox center', () => {
  const m = mat2DFor({ tx: 0, ty: 0, scale: 1, rot: Math.PI / 2 }, VB);
  // (100, 50) on the right edge of the box should rotate to (50, 100).
  const p = applyMat2D(m, 100, 50);
  assert.equal(Math.round(p.x), 50);
  assert.equal(Math.round(p.y), 100);
});

test('mat2DFor pan adds a pure translation', () => {
  const m = mat2DFor({ tx: 25, ty: -10, scale: 1, rot: 0 }, VB);
  const p = applyMat2D(m, 0, 0);
  assert.equal(Math.round(p.x), 25);
  assert.equal(Math.round(p.y), -10);
});

test('invertMat2D round-trips a non-trivial transform', () => {
  const m = mat2DFor({ tx: 12, ty: -7, scale: 1.5, rot: 0.6 }, VB);
  const mi = invertMat2D(m);
  assert.ok(mi);
  const a = applyMat2D(m, 33, 44);
  const b = applyMat2D(mi, a.x, a.y);
  assert.ok(Math.abs(b.x - 33) < 1e-6);
  assert.ok(Math.abs(b.y - 44) < 1e-6);
});

test('svgTransformFor identity matches the expected zero-effect string', () => {
  const t = svgTransformFor(IDENTITY_VIEW_2D, VB);
  assert.match(t, /translate\(50 50\) rotate\(0\) scale\(1\) translate\(-50 -50\)/);
});

test('interpolateKeyframes clamps before first and after last', () => {
  const kf = [
    { time: 1, value: 10 },
    { time: 3, value: 30 },
  ];
  assert.equal(interpolateKeyframes(kf, 0), 10);
  assert.equal(interpolateKeyframes(kf, 4), 30);
});

test('interpolateKeyframes interpolates linearly between adjacent frames', () => {
  const kf = [
    { time: 0, value: 0 },
    { time: 2, value: 100 },
  ];
  assert.equal(interpolateKeyframes(kf, 1), 50);
  assert.equal(interpolateKeyframes(kf, 0.5), 25);
});

test('interpolateKeyframes returns fallback when empty', () => {
  assert.equal(interpolateKeyframes([], 1, 14), 14);
});

test('interpolateKeyframes returns the lone value when single', () => {
  assert.equal(interpolateKeyframes([{ time: 1, value: 42 }], 99), 42);
});

test('keyframeDuration is the max time, or 0 for too few', () => {
  assert.equal(keyframeDuration([]), 0);
  assert.equal(keyframeDuration([{ time: 5, value: 1 }]), 0);
  assert.equal(keyframeDuration([{ time: 0, value: 0 }, { time: 4, value: 1 }]), 4);
});

test('unionViewBox covers all frames with padding', () => {
  const boxes = [
    [10, 10, 30, 30],
    [-5, 0, 25, 40],
  ];
  const vb = unionViewBox(boxes, 5);
  assert.deepEqual(vb, [-10, -5, 45, 50]);
});

test('unionViewBox falls back to a unit box when empty', () => {
  assert.deepEqual(unionViewBox([], 0), [0, 0, 1, 1]);
});

test('timelineDuration is at least minSeconds and one second past the last keyframe', () => {
  assert.equal(timelineDuration([], 4), 4);
  assert.equal(timelineDuration([{ time: 1, value: 0 }], 4), 4);
  assert.equal(timelineDuration([{ time: 5, value: 0 }, { time: 7, value: 0 }], 4), 8);
});

test('clampKeyframe clamps time non-negative and value into [0, max]', () => {
  assert.deepEqual(clampKeyframe({ time: -1, value: 99 }, 60), { time: 0, value: 60 });
  assert.deepEqual(clampKeyframe({ time: 2.5, value: 30 }, 60), { time: 2.5, value: 30 });
  assert.deepEqual(clampKeyframe({ time: 1, value: -5 }, 60), { time: 1, value: 0 });
});

// Regression test: keyframes are stored as `{ time, value }` and
// interpolateKeyframes reads `value`. A schema drift back to `inflate` would
// reintroduce the NaN-animation bug from commit 81d0b1a.
test('interpolateKeyframes uses the .value property (schema regression)', () => {
  const ok = [{ time: 0, value: 10 }, { time: 1, value: 20 }];
  assert.equal(interpolateKeyframes(ok, 0.5), 15);
  // If a developer accidentally wrote `inflate` instead, NaN would propagate:
  const wrong = [{ time: 0, inflate: 10 }, { time: 1, inflate: 20 }];
  const result = interpolateKeyframes(wrong, 0.5);
  assert.ok(Number.isNaN(result), 'a non-.value schema should return NaN, exposing the bug');
});

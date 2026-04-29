import assert from 'node:assert/strict';
import test from 'node:test';

import { buildBalloonMesh, pointInShape, triangulateShape } from './mesh.mjs';

function orientation(ax, ay, bx, by, cx, cy) {
  return (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
}

function segmentsCross(ax, ay, bx, by, cx, cy, dx, dy) {
  const d1 = orientation(ax, ay, bx, by, cx, cy);
  const d2 = orientation(ax, ay, bx, by, dx, dy);
  const d3 = orientation(cx, cy, dx, dy, ax, ay);
  const d4 = orientation(cx, cy, dx, dy, bx, by);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
         ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

function edgeCrossesRing(ax, ay, bx, by, ring) {
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    const cx = ring[i];
    const cy = ring[i + 1];
    const dx = ring[j];
    const dy = ring[j + 1];
    if ((ax === cx && ay === cy) || (ax === dx && ay === dy) ||
        (bx === cx && by === cy) || (bx === dx && by === dy)) {
      continue;
    }
    if (segmentsCross(ax, ay, bx, by, cx, cy, dx, dy)) return true;
  }
  return false;
}

function pointOnRing(px, py, ring) {
  const eps = 1e-9;
  for (let i = 0; i < ring.length; i += 2) {
    const j = (i + 2) % ring.length;
    const ax = ring[i];
    const ay = ring[i + 1];
    const bx = ring[j];
    const by = ring[j + 1];
    const dx = bx - ax;
    const dy = by - ay;
    const lenSq = dx * dx + dy * dy || 1;
    const t = ((px - ax) * dx + (py - ay) * dy) / lenSq;
    if (t < -eps || t > 1 + eps) continue;
    const cx = ax + Math.max(0, Math.min(1, t)) * dx;
    const cy = ay + Math.max(0, Math.min(1, t)) * dy;
    const ddx = px - cx;
    const ddy = py - cy;
    if (ddx * ddx + ddy * ddy <= eps) return true;
  }
  return false;
}

function pointOnShapeBoundary(px, py, outerRing, holes) {
  if (pointOnRing(px, py, outerRing)) return true;
  return holes.some((hole) => pointOnRing(px, py, hole));
}

function assertEdgeStaysInsideShape(positions, edge, outerRing, holes) {
  const [a, b] = edge;
  const ax = positions[a * 2];
  const ay = positions[a * 2 + 1];
  const bx = positions[b * 2];
  const by = positions[b * 2 + 1];
  const mx = (ax + bx) * 0.5;
  const my = (ay + by) * 0.5;

  assert.equal(
    pointInShape(mx, my, outerRing, holes) || pointOnShapeBoundary(mx, my, outerRing, holes),
    true,
    `edge midpoint (${mx}, ${my}) must stay inside the shape`
  );
  assert.equal(
    edgeCrossesRing(ax, ay, bx, by, outerRing),
    false,
    'triangle edge must not cross the outer boundary'
  );
  for (const hole of holes) {
    assert.equal(
      edgeCrossesRing(ax, ay, bx, by, hole),
      false,
      'triangle edge must not cross a hole boundary'
    );
  }
}

test('triangulateShape keeps cap triangles constrained to concave letter shapes', () => {
  const outerRing = new Float64Array([
    0, 0,
    12, 0,
    12, 3,
    4, 3,
    4, 9,
    12, 9,
    12, 12,
    0, 12,
  ]);

  const { positions, indices } = triangulateShape(outerRing, [], 4);

  assert.ok(indices.length > 0, 'expected a triangulated concave shape');
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    assertEdgeStaysInsideShape(positions, [a, b], outerRing, []);
    assertEdgeStaysInsideShape(positions, [b, c], outerRing, []);
    assertEdgeStaysInsideShape(positions, [c, a], outerRing, []);
  }
});

test('triangulateShape preserves holes without bridge triangles', () => {
  const outerRing = new Float64Array([
    0, 0,
    16, 0,
    16, 16,
    0, 16,
  ]);
  const hole = new Float64Array([
    5, 5,
    11, 5,
    11, 11,
    5, 11,
  ]);

  const { positions, indices } = triangulateShape(outerRing, [hole], 4);

  assert.ok(indices.length > 0, 'expected a triangulated shape with a hole');
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i];
    const b = indices[i + 1];
    const c = indices[i + 2];
    assertEdgeStaysInsideShape(positions, [a, b], outerRing, [hole]);
    assertEdgeStaysInsideShape(positions, [b, c], outerRing, [hole]);
    assertEdgeStaysInsideShape(positions, [c, a], outerRing, [hole]);
  }
});

test('buildBalloonMesh keeps front and back cap winding consistent', () => {
  const ring = new Float32Array([
    0, 0,
    100, 0,
    100, 100,
    0, 100,
  ]);

  const result = buildBalloonMesh([ring], { meshDensity: 14, thickness: 0.55 });

  assert.ok(result, 'expected mesh geometry');
  const positions = result.geom.attributes.position.array;
  const indices = result.geom.index.array;
  let frontFacing = 0;
  let backFacing = 0;
  let frontCount = 0;
  let backCount = 0;
  for (let i = 0; i < indices.length; i += 3) {
    const a = indices[i] * 3;
    const b = indices[i + 1] * 3;
    const c = indices[i + 2] * 3;
    const ux = positions[b] - positions[a];
    const uy = positions[b + 1] - positions[a + 1];
    const vx = positions[c] - positions[a];
    const vy = positions[c + 1] - positions[a + 1];
    const normalZ = ux * vy - uy * vx;
    const centerZ = (positions[a + 2] + positions[b + 2] + positions[c + 2]) / 3;
    if (centerZ >= 0) {
      frontCount++;
      if (normalZ > 0) frontFacing++;
    } else {
      backCount++;
      if (normalZ < 0) backFacing++;
    }
  }

  assert.ok(frontFacing / frontCount > 0.95, 'front cap normals should face the camera');
  assert.ok(backFacing / backCount > 0.95, 'back cap normals should face away from the camera');
});

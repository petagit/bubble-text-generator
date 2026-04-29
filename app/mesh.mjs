import Delaunator from 'delaunator';
import * as THREE from 'three';

export function pointInRing(px, py, ring) {
  let inside = false;
  const n = ring.length;
  for (let i = 0, j = n - 2; i < n; j = i, i += 2) {
    const xi = ring[i], yi = ring[i + 1];
    const xj = ring[j], yj = ring[j + 1];
    if ((yi > py) !== (yj > py) &&
        px < (xj - xi) * (py - yi) / (yj - yi) + xi) {
      inside = !inside;
    }
  }
  return inside;
}

export function pointInShape(px, py, outerRing, holes) {
  if (!pointInRing(px, py, outerRing)) return false;
  for (const hole of holes) {
    if (pointInRing(px, py, hole)) return false;
  }
  return true;
}

export function classifyShapes(rings) {
  // Use the first vertex as a topology probe. Centroids are unreliable for
  // glyphs with counters because an outer ring's centroid can land in a hole.
  const probes = rings.map((r) => [r[0], r[1]]);
  const info = rings.map((_, i) => {
    let count = 0, parent = -1, parentSize = Infinity;
    for (let j = 0; j < rings.length; j++) {
      if (i === j) continue;
      if (pointInRing(probes[i][0], probes[i][1], rings[j])) {
        count++;
        if (rings[j].length < parentSize) {
          parentSize = rings[j].length;
          parent = j;
        }
      }
    }
    return { count, parent };
  });

  const outers = [];
  const outerByIndex = new Map();
  for (let i = 0; i < rings.length; i++) {
    if (info[i].count % 2 === 0) {
      const outer = { ring: rings[i], holes: [] };
      outers.push(outer);
      outerByIndex.set(i, outer);
    }
  }
  for (let i = 0; i < rings.length; i++) {
    if (info[i].count % 2 === 1 && info[i].parent !== -1) {
      const parent = outerByIndex.get(info[i].parent);
      if (parent) parent.holes.push(rings[i]);
    }
  }
  return outers;
}

// Triangulate a shape (outer ring + holes).
//
// Delaunator is not a constrained triangulator, so it will happily add chords
// across concave bays and counters. We keep its near-equilateral triangle
// quality, then reject any triangle edge that leaves the actual glyph area.
export function triangulateShape(outerRing, holes, gridSpacing) {
  const positions = [];
  const ringRanges = [];

  const targetSpace = gridSpacing * 0.6;
  const addRing = (ring) => {
    const start = positions.length / 2;
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const ax = ring[i * 2], ay = ring[i * 2 + 1];
      positions.push(ax, ay);
      const j = (i + 1) % n;
      const bx = ring[j * 2], by = ring[j * 2 + 1];
      const segs = Math.max(1, Math.ceil(Math.hypot(bx - ax, by - ay) / targetSpace));
      for (let s = 1; s < segs; s++) {
        const t = s / segs;
        positions.push(ax + (bx - ax) * t, ay + (by - ay) * t);
      }
    }
    ringRanges.push({ start, count: positions.length / 2 - start });
  };
  addRing(outerRing);
  for (const hole of holes) addRing(hole);

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let i = 0; i < positions.length; i += 2) {
    if (positions[i] < minX) minX = positions[i];
    if (positions[i] > maxX) maxX = positions[i];
    if (positions[i + 1] < minY) minY = positions[i + 1];
    if (positions[i + 1] > maxY) maxY = positions[i + 1];
  }

  const binSize = Math.max(1, gridSpacing);
  const binKey = (gx, gy) => `${gx},${gy}`;

  const pointBins = new Map();
  const addPointBin = (x, y) => {
    const gx = Math.floor(x / binSize), gy = Math.floor(y / binSize);
    for (let oy = -1; oy <= 1; oy++) {
      for (let ox = -1; ox <= 1; ox++) {
        const key = binKey(gx + ox, gy + oy);
        let bin = pointBins.get(key);
        if (!bin) {
          bin = [];
          pointBins.set(key, bin);
        }
        bin.push(x, y);
      }
    }
  };
  for (let i = 0; i < positions.length; i += 2) addPointBin(positions[i], positions[i + 1]);

  const minDistSq = (gridSpacing * 0.5) * (gridSpacing * 0.5);
  const tooClose = (x, y) => {
    const bin = pointBins.get(binKey(Math.floor(x / binSize), Math.floor(y / binSize)));
    if (!bin) return false;
    for (let i = 0; i < bin.length; i += 2) {
      const dx = bin[i] - x, dy = bin[i + 1] - y;
      if (dx * dx + dy * dy < minDistSq) return true;
    }
    return false;
  };

  const hx = gridSpacing;
  const hy = gridSpacing * 0.866;
  let row = 0;
  for (let y = minY + hy * 0.5; y < maxY; y += hy, row++) {
    const xOff = (row & 1) ? hx * 0.5 : 0;
    for (let x = minX + xOff + hx * 0.5; x < maxX; x += hx) {
      if (tooClose(x, y)) continue;
      if (!pointInShape(x, y, outerRing, holes)) continue;
      positions.push(x, y);
      addPointBin(x, y);
    }
  }

  if (positions.length < 6) return { positions, indices: [] };

  let delaunay;
  try {
    delaunay = new Delaunator(new Float64Array(positions));
  } catch {
    return { positions, indices: [] };
  }

  const segList = [];
  for (const { start, count } of ringRanges) {
    for (let i = 0; i < count; i++) {
      segList.push(start + i, start + (i + 1) % count);
    }
  }
  const edgeKey = (a, b) => a < b ? `${a},${b}` : `${b},${a}`;
  const constrained = new Set();
  for (let i = 0; i < segList.length; i += 2) {
    constrained.add(edgeKey(segList[i], segList[i + 1]));
  }

  const segBins = new Map();
  for (let s = 0; s < segList.length; s += 2) {
    const a = segList[s], b = segList[s + 1];
    const ax = positions[a * 2], ay = positions[a * 2 + 1];
    const bx = positions[b * 2], by = positions[b * 2 + 1];
    const x0 = Math.floor(Math.min(ax, bx) / binSize);
    const x1 = Math.floor(Math.max(ax, bx) / binSize);
    const y0 = Math.floor(Math.min(ay, by) / binSize);
    const y1 = Math.floor(Math.max(ay, by) / binSize);
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const key = binKey(gx, gy);
        let bin = segBins.get(key);
        if (!bin) {
          bin = [];
          segBins.set(key, bin);
        }
        bin.push(s);
      }
    }
  }

  const segmentsCross = (ax, ay, bx, by, cx, cy, dx, dy) => {
    const d1 = (bx - ax) * (cy - ay) - (by - ay) * (cx - ax);
    const d2 = (bx - ax) * (dy - ay) - (by - ay) * (dx - ax);
    const d3 = (dx - cx) * (ay - cy) - (dy - cy) * (ax - cx);
    const d4 = (dx - cx) * (by - cy) - (dy - cy) * (bx - cx);
    return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) &&
           ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
  };

  const edgeCrossesBoundary = (aIdx, bIdx) => {
    const ax = positions[aIdx * 2], ay = positions[aIdx * 2 + 1];
    const bx = positions[bIdx * 2], by = positions[bIdx * 2 + 1];
    const x0 = Math.floor(Math.min(ax, bx) / binSize);
    const x1 = Math.floor(Math.max(ax, bx) / binSize);
    const y0 = Math.floor(Math.min(ay, by) / binSize);
    const y1 = Math.floor(Math.max(ay, by) / binSize);
    const seen = new Set();
    for (let gy = y0; gy <= y1; gy++) {
      for (let gx = x0; gx <= x1; gx++) {
        const bin = segBins.get(binKey(gx, gy));
        if (!bin) continue;
        for (const s of bin) {
          if (seen.has(s)) continue;
          seen.add(s);
          const sa = segList[s], sb = segList[s + 1];
          if (sa === aIdx || sa === bIdx || sb === aIdx || sb === bIdx) continue;
          if (segmentsCross(
            ax, ay, bx, by,
            positions[sa * 2], positions[sa * 2 + 1],
            positions[sb * 2], positions[sb * 2 + 1]
          )) return true;
        }
      }
    }
    return false;
  };

  const edgeStaysInsideShape = (aIdx, bIdx) => {
    if (constrained.has(edgeKey(aIdx, bIdx))) return true;
    const ax = positions[aIdx * 2], ay = positions[aIdx * 2 + 1];
    const bx = positions[bIdx * 2], by = positions[bIdx * 2 + 1];
    if (!pointInShape((ax + bx) * 0.5, (ay + by) * 0.5, outerRing, holes)) return false;
    return !edgeCrossesBoundary(aIdx, bIdx);
  };

  const kept = [];
  const tris = delaunay.triangles;
  for (let i = 0; i < tris.length; i += 3) {
    const a = tris[i], b = tris[i + 1], c = tris[i + 2];
    const cx = (positions[a * 2] + positions[b * 2] + positions[c * 2]) / 3;
    const cy = (positions[a * 2 + 1] + positions[b * 2 + 1] + positions[c * 2 + 1]) / 3;
    if (!pointInShape(cx, cy, outerRing, holes)) continue;
    if (!edgeStaysInsideShape(a, b)) continue;
    if (!edgeStaysInsideShape(b, c)) continue;
    if (!edgeStaysInsideShape(c, a)) continue;
    kept.push(a, b, c);
  }

  return { positions, indices: kept };
}

function distToRingSq(px, py, ring) {
  let best = Infinity;
  const n = ring.length / 2;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ax = ring[i * 2], ay = ring[i * 2 + 1];
    const bx = ring[j * 2], by = ring[j * 2 + 1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy || 1;
    let t = ((px - ax) * dx + (py - ay) * dy) / len2;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
    const cx = ax + t * dx, cy = ay + t * dy;
    const ddx = px - cx, ddy = py - cy;
    const d = ddx * ddx + ddy * ddy;
    if (d < best) best = d;
  }
  return best;
}

export function buildBalloonMesh(rings, params) {
  if (!rings || rings.length === 0) return null;
  const shapes = classifyShapes(rings);
  if (shapes.length === 0) return null;

  let gMinX = Infinity, gMinY = Infinity, gMaxX = -Infinity, gMaxY = -Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      if (ring[i] < gMinX) gMinX = ring[i];
      if (ring[i] > gMaxX) gMaxX = ring[i];
      if (ring[i + 1] < gMinY) gMinY = ring[i + 1];
      if (ring[i + 1] > gMaxY) gMaxY = ring[i + 1];
    }
  }
  if (!isFinite(gMinX)) return null;

  const charScale = Math.min(gMaxY - gMinY, gMaxX - gMinX);
  const gridSpacing = Math.max(2, charScale / params.meshDensity);

  const finalPos = [];
  const finalIdx = [];

  for (const shape of shapes) {
    const tri = triangulateShape(shape.ring, shape.holes, gridSpacing);
    const pos = tri.positions;
    const idx = tri.indices;
    if (idx.length === 0) continue;
    const numVerts = pos.length / 2;

    const shapeRings = [shape.ring, ...shape.holes];
    const dist = new Float32Array(numVerts);
    let localMaxDist = 0;
    for (let v = 0; v < numVerts; v++) {
      const px = pos[v * 2], py = pos[v * 2 + 1];
      let dSq = Infinity;
      for (const ring of shapeRings) {
        const d = distToRingSq(px, py, ring);
        if (d < dSq) dSq = d;
      }
      dist[v] = Math.sqrt(dSq);
      if (dist[v] > localMaxDist) localMaxDist = dist[v];
    }
    if (localMaxDist <= 0.0001) continue;

    const thickness = params.thickness * localMaxDist;
    const heights = new Float32Array(numVerts);
    for (let v = 0; v < numVerts; v++) {
      const t = Math.min(1, dist[v] / localMaxDist);
      heights[v] = (2 * t - t * t) * thickness;
    }

    const isBoundary = new Uint8Array(numVerts);
    const boundaryThresh = thickness * 0.005;
    for (let v = 0; v < numVerts; v++) {
      if (heights[v] <= boundaryThresh) isBoundary[v] = 1;
    }

    const neighborCount = new Int32Array(numVerts);
    for (let i = 0; i < idx.length; i++) neighborCount[idx[i]] += 2;
    const neighborStart = new Int32Array(numVerts + 1);
    for (let v = 0; v < numVerts; v++) neighborStart[v + 1] = neighborStart[v] + neighborCount[v];
    const neighborBuf = new Int32Array(neighborStart[numVerts]);
    const fillCursor = new Int32Array(numVerts);
    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      neighborBuf[neighborStart[a] + fillCursor[a]++] = b;
      neighborBuf[neighborStart[a] + fillCursor[a]++] = c;
      neighborBuf[neighborStart[b] + fillCursor[b]++] = a;
      neighborBuf[neighborStart[b] + fillCursor[b]++] = c;
      neighborBuf[neighborStart[c] + fillCursor[c]++] = a;
      neighborBuf[neighborStart[c] + fillCursor[c]++] = b;
    }

    let cur = heights;
    let nxt = new Float32Array(numVerts);
    const smoothPasses = 6;
    const lambda = 0.55;
    for (let iter = 0; iter < smoothPasses; iter++) {
      for (let v = 0; v < numVerts; v++) {
        if (isBoundary[v]) {
          nxt[v] = cur[v];
          continue;
        }
        const start = neighborStart[v], end = neighborStart[v + 1];
        let sum = 0;
        for (let k = start; k < end; k++) sum += cur[neighborBuf[k]];
        const avg = sum / (end - start);
        nxt[v] = cur[v] + lambda * (avg - cur[v]);
      }
      const temp = cur;
      cur = nxt;
      nxt = temp;
    }

    let smoothMax = 0;
    for (let v = 0; v < numVerts; v++) if (cur[v] > smoothMax) smoothMax = cur[v];
    if (smoothMax > 0) {
      const scale = thickness / smoothMax;
      for (let v = 0; v < numVerts; v++) cur[v] *= scale;
    }
    const finalHeights = cur;

    const frontMap = new Int32Array(numVerts);
    const backMap = new Int32Array(numVerts);
    for (let v = 0; v < numVerts; v++) {
      const x = pos[v * 2];
      const y = -pos[v * 2 + 1];
      if (finalHeights[v] <= boundaryThresh) {
        const id = finalPos.length / 3;
        finalPos.push(x, y, 0);
        frontMap[v] = id;
        backMap[v] = id;
      } else {
        const frontId = finalPos.length / 3;
        finalPos.push(x, y, finalHeights[v]);
        const backId = frontId + 1;
        finalPos.push(x, y, -finalHeights[v]);
        frontMap[v] = frontId;
        backMap[v] = backId;
      }
    }

    for (let i = 0; i < idx.length; i += 3) {
      const a = idx[i], b = idx[i + 1], c = idx[i + 2];
      finalIdx.push(frontMap[a], frontMap[b], frontMap[c]);
      finalIdx.push(backMap[a], backMap[c], backMap[b]);
    }
  }

  if (finalIdx.length === 0) return null;

  const positions = new Float32Array(finalPos);
  const numFinalVerts = positions.length / 3;
  const IndexCtor = numFinalVerts > 65535 ? Uint32Array : Uint16Array;
  const indices = new IndexCtor(finalIdx);

  const geom = new THREE.BufferGeometry();
  geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  geom.setIndex(new THREE.BufferAttribute(indices, 1));
  geom.computeVertexNormals();

  const cx = (gMinX + gMaxX) * 0.5;
  const cy = -(gMinY + gMaxY) * 0.5;
  geom.translate(-cx, -cy, 0);
  return { geom, bbox: new THREE.Box3().setFromBufferAttribute(geom.attributes.position) };
}

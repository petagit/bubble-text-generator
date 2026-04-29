import { SVGLoader } from 'three/addons/loaders/SVGLoader.js';

// Standard shoelace signed area of a flat ring. Positive when the vertices
// are traversed counter-clockwise in math (y-up) convention, which is the
// same as visually clockwise on the y-down screen the rest of the pipeline
// works in.
export function ringSignedArea(ring) {
  const n = ring.length / 2;
  if (n < 3) return 0;
  let area = 0;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += ring[i * 2] * ring[j * 2 + 1] - ring[j * 2] * ring[i * 2 + 1];
  }
  return area * 0.5;
}

export function reverseRing(ring) {
  const n = ring.length / 2;
  const out = new Float64Array(ring.length);
  for (let i = 0; i < n; i++) {
    out[i * 2]     = ring[(n - 1 - i) * 2];
    out[i * 2 + 1] = ring[(n - 1 - i) * 2 + 1];
  }
  return out;
}

// The worker's morphological offset (`public/worker.js`) always pushes each
// edge along its right perpendicular `(ey, -ex)`. With our shoelace formula,
// rings with POSITIVE signed area have that perpendicular pointing outward —
// matching opentype.js's outer-ring convention for glyph silhouettes. Counter
// holes have NEGATIVE area so the same offset shrinks them (which thickens
// the glyph body when the offset is applied with a positive distance). SVG
// rings get rewound to that polarity before they enter the pipeline so the
// inflate slider behaves identically for fonts and uploaded artwork.
export function ensureWinding(ring, wantPositiveArea) {
  if (ring.length < 6) return ring;
  const isPositive = ringSignedArea(ring) > 0;
  return isPositive === wantPositiveArea ? ring : reverseRing(ring);
}

// THREE's Curve.getPoints() often closes a contour by repeating the first
// vertex at the end. The marching-squares stitcher and offset code assume an
// open vertex list (the closing edge is implicit), so drop the trailing
// duplicate when present.
export function vector2ListToFlatRing(points) {
  const n = points.length;
  if (n < 2) return new Float64Array(0);
  let count = n;
  const first = points[0];
  const last = points[n - 1];
  if (Math.abs(first.x - last.x) < 1e-9 && Math.abs(first.y - last.y) < 1e-9) {
    count = n - 1;
  }
  const ring = new Float64Array(count * 2);
  for (let i = 0; i < count; i++) {
    ring[i * 2]     = points[i].x;
    ring[i * 2 + 1] = points[i].y;
  }
  return ring;
}

export function computeRingsBounds(rings) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      if (ring[i] < minX) minX = ring[i];
      if (ring[i] > maxX) maxX = ring[i];
      if (ring[i + 1] < minY) minY = ring[i + 1];
      if (ring[i + 1] > maxY) maxY = ring[i + 1];
    }
  }
  return { minX, minY, maxX, maxY };
}

// Rescale + recenter so the SVG's larger axis fits `targetSize` units. This
// puts an uploaded file into the same coordinate scale opentype.js uses for
// glyphs (a single letter is ~200 units tall when fontSize=200), which is
// what the inflate / blur / 3D thickness sliders are tuned against.
export function normalizeRingsToTargetSize(rings, targetSize) {
  const { minX, minY, maxX, maxY } = computeRingsBounds(rings);
  if (!isFinite(minX)) return rings;
  const w = maxX - minX;
  const h = maxY - minY;
  const ref = Math.max(w, h, 1e-6);
  const scale = targetSize / ref;
  const cx = (minX + maxX) * 0.5;
  const cy = (minY + maxY) * 0.5;
  for (const ring of rings) {
    for (let i = 0; i < ring.length; i += 2) {
      ring[i]     = (ring[i] - cx) * scale;
      ring[i + 1] = (ring[i + 1] - cy) * scale;
    }
  }
  return rings;
}

// Browser-only: parses SVG markup with three's SVGLoader, materializes
// fillable shapes (respecting fill-rule and nested holes), and returns a
// flat list of Float64Array rings ready to drop into `glyphPolys` slot the
// existing pipeline already consumes.
export function svgTextToPolys(svgText, { divisions = 24, targetSize = 360 } = {}) {
  const loader = new SVGLoader();
  let data;
  try {
    data = loader.parse(svgText);
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    throw new Error(`SVG parse failed: ${msg}`);
  }

  const rings = [];
  for (const path of data.paths) {
    const shapes = SVGLoader.createShapes(path);
    for (const shape of shapes) {
      const { shape: outerPts, holes } = shape.extractPoints(divisions);
      const outer = vector2ListToFlatRing(outerPts);
      if (outer.length >= 6) rings.push(ensureWinding(outer, /* wantPositiveArea */ true));
      for (const holePts of holes) {
        const hole = vector2ListToFlatRing(holePts);
        if (hole.length >= 6) rings.push(ensureWinding(hole, /* wantPositiveArea */ false));
      }
    }
  }

  if (rings.length === 0) return null;
  return normalizeRingsToTargetSize(rings, targetSize);
}

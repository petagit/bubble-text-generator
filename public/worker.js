/* Bubble-text geometry worker.
 * Pipeline: glyph polygons → analytical offset → rasterize alpha →
 * (optional) blur+threshold for soft-merge → marching squares (segment
 * emit + stitch) → SVG path string.
 *
 * The marching squares uses the textbook segment-list-per-cell approach
 * with linear interpolation between corner samples and explicit saddle
 * disambiguation by the cell-center average. Segments are then stitched
 * into closed rings via an endpoint hash map. This is robust to all 16
 * cell configurations including saddle points, and traces every contour
 * (including interior holes) in one pass.
 */

self.onmessage = (e) => {
  const job = e.data;
  try {
    const out = run(job);
    self.postMessage({ id: job.id, ok: true, ...out });
  } catch (err) {
    self.postMessage({ id: job.id, ok: false, error: String(err && err.stack || err) });
  }
};

/* ============================================================
   Polygon offset (analytical, fast).
   ============================================================ */
function offsetRing(ring, d, arcQuality) {
  const n = ring.length / 2;
  if (n < 3 || d === 0) return ring.slice();
  // Morphological dilation: always push along the right perpendicular by +d.
  // For CCW outer rings, right perp = outward → ring expands. For CW counter
  // rings, right perp = inward (into the bounded region, which IS the hole)
  // → hole shrinks, glyph body thickens. Both effects are exactly what we
  // want for a "puff up" of glyph silhouettes.
  const nx = new Float64Array(n), ny = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    const ex = ring[j*2] - ring[i*2], ey = ring[j*2+1] - ring[i*2+1];
    const len = Math.hypot(ex, ey) || 1;
    nx[i] = ey / len;
    ny[i] = -ex / len;
  }
  const out = [];
  const arcStep = Math.PI / Math.max(2, arcQuality);
  for (let i = 0; i < n; i++) {
    const prev = (i - 1 + n) % n;
    const px = ring[i*2], py = ring[i*2+1];
    const ax = px + nx[prev] * d, ay = py + ny[prev] * d;
    const bx = px + nx[i] * d,    by = py + ny[i] * d;
    const cross = nx[prev] * ny[i] - ny[prev] * nx[i];
    if (Math.abs(cross) < 1e-6) {
      out.push(ax, ay);
    } else if ((d > 0 && cross > 0) || (d < 0 && cross < 0)) {
      let a0 = Math.atan2(ay - py, ax - px);
      let a1 = Math.atan2(by - py, bx - px);
      let da = a1 - a0;
      while (da < 0) da += Math.PI * 2;
      const segs = Math.max(1, Math.ceil(da / arcStep));
      const r = Math.abs(d);
      for (let s = 0; s <= segs; s++) {
        const t = a0 + da * (s / segs);
        out.push(px + Math.cos(t) * r, py + Math.sin(t) * r);
      }
    } else {
      out.push((ax + bx) * 0.5, (ay + by) * 0.5);
    }
  }
  return new Float64Array(out);
}

/* ============================================================
   RDP decimation on a flat ring.
   ============================================================ */
function rdp(flat, eps) {
  const n = flat.length / 2;
  if (n < 3) return flat;
  const sqEps = eps * eps;
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[n - 1] = 1;
  const stack = [[0, n - 1]];
  while (stack.length) {
    const [a, b] = stack.pop();
    let maxD = 0, idx = -1;
    const ax = flat[a*2], ay = flat[a*2+1];
    const bx = flat[b*2], by = flat[b*2+1];
    const dx = bx - ax, dy = by - ay;
    const len2 = dx*dx + dy*dy || 1;
    for (let i = a + 1; i < b; i++) {
      const px = flat[i*2], py = flat[i*2+1];
      const t = ((px - ax) * dx + (py - ay) * dy) / len2;
      const cx = ax + t * dx, cy = ay + t * dy;
      const d2 = (px - cx)*(px - cx) + (py - cy)*(py - cy);
      if (d2 > maxD) { maxD = d2; idx = i; }
    }
    if (maxD > sqEps && idx > -1) {
      keep[idx] = 1;
      stack.push([a, idx], [idx, b]);
    }
  }
  const out = [];
  for (let i = 0; i < n; i++) if (keep[i]) out.push(flat[i*2], flat[i*2+1]);
  return new Float64Array(out);
}

/* ============================================================
   MARCHING SQUARES — segment emit + stitch.
   field: Float32Array of size W*H (alpha 0..255).
   threshold: scalar value for the iso-contour.
   Returns array of closed rings, each Float64Array of x,y in image space.
   ============================================================ */
function marchingSquares(field, W, H, threshold) {
  // Each cell has 4 corners (TL, TR, BR, BL) and 4 edges (top, right, bottom, left).
  // Corner index in the field: tl = (cx,cy), tr = (cx+1,cy), br = (cx+1,cy+1), bl = (cx,cy+1).
  // Edge IDs (unique global ints) — we use them as keys for the segment-stitch hash map:
  //   top    edge of cell (cx,cy):  2*cx + 2*cy*(2W) + 0   == base + 0
  //   right  edge of cell (cx,cy):  2*(cx+1) + 2*cy*(2W) + 1   no — use scheme:
  // Cleaner scheme: we identify each edge by the index of its "owner cell-corner"
  // pair. Horizontal edges (top of cell): (cx, cy) → (cx+1, cy). Use ID = (cy*W + cx)*2 + 0.
  // Vertical edges (left of cell):    (cx, cy) → (cx, cy+1). Use ID = (cy*W + cx)*2 + 1.
  // Then top edge of cell (cx,cy) = horizontal edge at (cx, cy).
  //      bottom edge of cell (cx,cy) = horizontal edge at (cx, cy+1).
  //      left edge of cell (cx,cy) = vertical edge at (cx, cy).
  //      right edge of cell (cx,cy) = vertical edge at (cx+1, cy).
  // Each edge has at most one crossing (one (x,y) point). We compute the point lazily
  // and key it by the edge ID.

  const edgePoints = new Map(); // edgeId -> [x, y]
  const segments = [];          // pairs of edgeIds: [aId, bId, aId, bId, ...]

  function horizId(cx, cy) { return (cy * W + cx) * 2 + 0; }
  function vertId(cx, cy)  { return (cy * W + cx) * 2 + 1; }

  function getHorizPoint(cx, cy) {
    const id = horizId(cx, cy);
    let p = edgePoints.get(id);
    if (p) return [id, p];
    const a = field[cy * W + cx];
    const b = field[cy * W + (cx + 1)];
    let t = (threshold - a) / (b - a);
    if (!isFinite(t)) t = 0.5;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    p = [cx + t, cy];
    edgePoints.set(id, p);
    return [id, p];
  }
  function getVertPoint(cx, cy) {
    const id = vertId(cx, cy);
    let p = edgePoints.get(id);
    if (p) return [id, p];
    const a = field[cy * W + cx];
    const b = field[(cy + 1) * W + cx];
    let t = (threshold - a) / (b - a);
    if (!isFinite(t)) t = 0.5;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    p = [cx, cy + t];
    edgePoints.set(id, p);
    return [id, p];
  }

  // Cell-to-segment lookup. Each entry is a list of edge-pair indices, where
  // edges are: 0=top, 1=right, 2=bottom, 3=left. Saddles (5, 10) are resolved
  // dynamically using the cell-center average.
  // Outward winding (solid on inside, hole CCW etc.) is maintained by:
  //   for each segment, the contour walks from edge A to edge B such that the
  //   "solid" side is on the left of the walk direction. For our purposes
  //   (filling) any consistent winding works because SVG nonzero fill handles it.
  function emitForCell(cx, cy) {
    const tl = field[cy * W + cx]            >= threshold ? 1 : 0;
    const tr = field[cy * W + (cx + 1)]       >= threshold ? 1 : 0;
    const br = field[(cy + 1) * W + (cx + 1)] >= threshold ? 1 : 0;
    const bl = field[(cy + 1) * W + cx]       >= threshold ? 1 : 0;
    const cfg = tl | (tr << 1) | (br << 2) | (bl << 3);
    if (cfg === 0 || cfg === 15) return;

    const top    = () => getHorizPoint(cx, cy);
    const right  = () => getVertPoint(cx + 1, cy);
    const bottom = () => getHorizPoint(cx, cy + 1);
    const left   = () => getVertPoint(cx, cy);

    let pairs;
    if (cfg === 5 || cfg === 10) {
      // Saddle. Disambiguate using cell-center average of the four samples.
      const avg = (field[cy*W+cx] + field[cy*W+cx+1] + field[(cy+1)*W+cx+1] + field[(cy+1)*W+cx]) * 0.25;
      const center = avg >= threshold ? 1 : 0;
      if (cfg === 5) {
        // tl, br are 1; tr, bl are 0
        pairs = center
          ? [[left(), top()], [right(), bottom()]]   // connected through center
          : [[left(), bottom()], [right(), top()]];  // disjoint
      } else {
        // tr, bl are 1; tl, br are 0
        pairs = center
          ? [[top(), right()], [bottom(), left()]]
          : [[top(), left()], [bottom(), right()]];
      }
    } else {
      switch (cfg) {
        case 1:  pairs = [[left(), top()]]; break;
        case 2:  pairs = [[top(), right()]]; break;
        case 3:  pairs = [[left(), right()]]; break;
        case 4:  pairs = [[right(), bottom()]]; break;
        case 6:  pairs = [[top(), bottom()]]; break;
        case 7:  pairs = [[left(), bottom()]]; break;
        case 8:  pairs = [[bottom(), left()]]; break;
        case 9:  pairs = [[bottom(), top()]]; break;
        case 11: pairs = [[bottom(), right()]]; break;
        case 12: pairs = [[right(), left()]]; break;
        case 13: pairs = [[right(), top()]]; break;
        case 14: pairs = [[top(), left()]]; break;
      }
    }
    for (const [a, b] of pairs) segments.push(a[0], b[0]);
  }

  for (let cy = 0; cy < H - 1; cy++) {
    for (let cx = 0; cx < W - 1; cx++) {
      emitForCell(cx, cy);
    }
  }

  // Stitch segments into closed rings.
  // Each segment has index k = i/2. For each edge ID, store the (up to 2)
  // segment indices that touch it. We walk by alternating "find segment
  // touching current edge" → "jump to other end of that segment".
  const segCount = segments.length / 2;
  const edgeSegs = new Map(); // edgeId -> [segIdx0, segIdx1]
  for (let k = 0; k < segCount; k++) {
    const a = segments[k * 2], b = segments[k * 2 + 1];
    let la = edgeSegs.get(a); if (!la) { la = [-1, -1]; edgeSegs.set(a, la); }
    let lb = edgeSegs.get(b); if (!lb) { lb = [-1, -1]; edgeSegs.set(b, lb); }
    if (la[0] === -1) la[0] = k; else la[1] = k;
    if (lb[0] === -1) lb[0] = k; else lb[1] = k;
  }

  const visited = new Uint8Array(segCount);
  const rings = [];

  for (let startK = 0; startK < segCount; startK++) {
    if (visited[startK]) continue;
    visited[startK] = 1;

    const startEdge = segments[startK * 2];
    const ringPts = [];
    const sp = edgePoints.get(startEdge);
    ringPts.push(sp[0], sp[1]);

    let curEdge = segments[startK * 2 + 1];
    let safety = segCount + 4;
    while (safety-- > 0) {
      const pt = edgePoints.get(curEdge);
      ringPts.push(pt[0], pt[1]);
      if (curEdge === startEdge) break;
      // Find the next unvisited segment touching curEdge.
      const ks = edgeSegs.get(curEdge);
      if (!ks) break;
      let nextK = -1;
      if (ks[0] !== -1 && !visited[ks[0]]) nextK = ks[0];
      else if (ks[1] !== -1 && !visited[ks[1]]) nextK = ks[1];
      if (nextK === -1) break;
      visited[nextK] = 1;
      // Move to the OTHER edge of segment nextK.
      const a = segments[nextK * 2], b = segments[nextK * 2 + 1];
      curEdge = (a === curEdge) ? b : a;
    }
    if (ringPts.length >= 6) rings.push(new Float64Array(ringPts));
  }

  return rings;
}

/* ============================================================
   Build the alpha field by manual scanline rasterization.
   We need a Float32Array field for marching squares. We could use
   OffscreenCanvas, but doing it ourselves removes the round-trip cost
   (`getImageData` → Uint8 → Float32 conversion) and supports box-blur
   approximation of Gaussian via separable passes.
   ============================================================ */
function rasterizePolygons(rings, W, H) {
  // Scanline polygon fill with non-zero winding rule.
  // Pixel is "inside" wherever the running signed crossing count != 0.
  // This treats overlapping rings as union (good for our offset glyphs)
  // and correctly subtracts counter holes (P, A, R) which opentype winds
  // opposite to outer rings.
  const field = new Float32Array(W * H);
  const eYmin = [], eYmax = [], eX = [], eSlope = [], eDir = [];
  for (let r = 0; r < rings.length; r++) {
    const ring = rings[r];
    const n = ring.length / 2;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      const x1 = ring[i*2], y1 = ring[i*2+1];
      const x2 = ring[j*2], y2 = ring[j*2+1];
      if (y1 === y2) continue;
      let yLo, yHi, xLo, dx, dir;
      if (y1 < y2) { yLo = y1; yHi = y2; xLo = x1; dx = (x2 - x1) / (y2 - y1); dir = +1; }
      else         { yLo = y2; yHi = y1; xLo = x2; dx = (x1 - x2) / (y1 - y2); dir = -1; }
      eYmin.push(yLo); eYmax.push(yHi); eX.push(xLo); eSlope.push(dx); eDir.push(dir);
    }
  }

  const buckets = new Array(H);
  for (let i = 0; i < H; i++) buckets[i] = [];
  for (let i = 0; i < eYmin.length; i++) {
    const y0 = Math.max(0, Math.ceil(eYmin[i]));
    if (y0 < H) buckets[y0].push(i);
  }

  const active = [], activeX = [];

  for (let y = 0; y < H; y++) {
    const adds = buckets[y];
    for (let k = 0; k < adds.length; k++) {
      const ei = adds[k];
      const stepUp = y - eYmin[ei];
      active.push(ei);
      activeX.push(eX[ei] + eSlope[ei] * stepUp);
    }
    for (let k = active.length - 1; k >= 0; k--) {
      if (eYmax[active[k]] <= y) {
        active.splice(k, 1);
        activeX.splice(k, 1);
      }
    }
    // Insertion sort active by current X
    for (let i = 1; i < activeX.length; i++) {
      const xi = activeX[i], ai = active[i];
      let j = i - 1;
      while (j >= 0 && activeX[j] > xi) {
        activeX[j+1] = activeX[j];
        active[j+1]  = active[j];
        j--;
      }
      activeX[j+1] = xi;
      active[j+1]  = ai;
    }
    // Walk crossings, accumulate winding, fill where winding != 0
    const rowBase = y * W;
    let winding = 0;
    let spanStart = -1;
    for (let i = 0; i < activeX.length; i++) {
      const before = winding;
      winding += eDir[active[i]];
      const insideBefore = before !== 0;
      const insideAfter  = winding !== 0;
      if (!insideBefore && insideAfter) {
        spanStart = activeX[i];
      } else if (insideBefore && !insideAfter && spanStart >= 0) {
        const x0 = Math.max(0, Math.ceil(spanStart));
        const x1 = Math.min(W - 1, Math.floor(activeX[i]));
        for (let x = x0; x <= x1; x++) field[rowBase + x] = 255;
        spanStart = -1;
      }
    }
    for (let i = 0; i < active.length; i++) {
      activeX[i] += eSlope[active[i]];
    }
  }
  return field;
}

/* Separable box blur, repeated to approximate Gaussian. radius in pixels. */
function boxBlur(src, W, H, radius, passes) {
  if (radius <= 0 || passes <= 0) return src;
  const tmp = new Float32Array(src.length);
  let a = src, b = tmp;
  for (let p = 0; p < passes; p++) {
    // Horizontal
    for (let y = 0; y < H; y++) {
      const row = y * W;
      let acc = 0;
      const r = radius;
      const win = r * 2 + 1;
      // Initialize window
      for (let x = -r; x <= r; x++) {
        const ix = x < 0 ? 0 : (x >= W ? W - 1 : x);
        acc += a[row + ix];
      }
      for (let x = 0; x < W; x++) {
        b[row + x] = acc / win;
        const outIdx = x - r;
        const inIdx = x + r + 1;
        const outV = a[row + (outIdx < 0 ? 0 : outIdx)];
        const inV = a[row + (inIdx >= W ? W - 1 : inIdx)];
        acc += inV - outV;
      }
    }
    // Swap
    let s = a; a = b; b = s;
    // Vertical
    for (let x = 0; x < W; x++) {
      let acc = 0;
      const r = radius;
      const win = r * 2 + 1;
      for (let y = -r; y <= r; y++) {
        const iy = y < 0 ? 0 : (y >= H ? H - 1 : y);
        acc += a[iy * W + x];
      }
      for (let y = 0; y < H; y++) {
        b[y * W + x] = acc / win;
        const outIdx = y - r;
        const inIdx = y + r + 1;
        const outV = a[(outIdx < 0 ? 0 : outIdx) * W + x];
        const inV = a[(inIdx >= H ? H - 1 : inIdx) * W + x];
        acc += inV - outV;
      }
    }
    let s2 = a; a = b; b = s2;
  }
  // Copy back if we ended on tmp
  if (a !== src) {
    src.set(a);
  }
  return src;
}

/* ============================================================
   Convert rings → SVG path "d" (in world space).
   ============================================================ */
function ringsToPath(rings, sx, sy, tx, ty, decimateEps) {
  const parts = [];
  for (let r = 0; r < rings.length; r++) {
    let ring = rings[r];
    if (decimateEps > 0) ring = rdp(ring, decimateEps);
    if (ring.length < 6) continue;
    const buf = ['M'];
    const wx0 = (ring[0] - tx) / sx, wy0 = (ring[1] - ty) / sy;
    buf.push(wx0.toFixed(1), wy0.toFixed(1));
    for (let i = 2; i < ring.length; i += 2) {
      const wx = (ring[i] - tx) / sx, wy = (ring[i+1] - ty) / sy;
      buf.push('L', wx.toFixed(1), wy.toFixed(1));
    }
    buf.push('Z');
    parts.push(buf.join(' '));
  }
  return parts.join(' ');
}

/* ============================================================
   Main pipeline
   ============================================================ */
function run(job) {
  const { glyphPolys, cursorOffsets, inflate, arcQuality, gridRes, blurPx,
          mergeAll, decimateEps } = job;

  // 1. Offset every ring of every glyph and translate by cursor.
  const allRings = [];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (let g = 0; g < glyphPolys.length; g++) {
    const polys = glyphPolys[g];
    const tx = cursorOffsets[g];
    for (let r = 0; r < polys.length; r++) {
      const off = inflate === 0 ? polys[r].slice() : offsetRing(polys[r], inflate, arcQuality);
      for (let i = 0; i < off.length; i += 2) {
        off[i] += tx;
        if (off[i] < minX) minX = off[i]; if (off[i] > maxX) maxX = off[i];
        if (off[i+1] < minY) minY = off[i+1]; if (off[i+1] > maxY) maxY = off[i+1];
      }
      allRings.push(off);
    }
  }
  if (!isFinite(minX)) return { d: '', bbox: [0,0,1,1] };

  // 2. Raster transform.
  const pad = inflate + blurPx + 4;
  const wWorld = (maxX - minX) + pad * 2;
  const hWorld = (maxY - minY) + pad * 2;
  const W = Math.max(16, Math.min(2048, Math.round(wWorld * gridRes)));
  const H = Math.max(16, Math.min(2048, Math.round(hWorld * gridRes)));
  const sx = W / wWorld, sy = H / hWorld;
  const tx = (-minX + pad) * sx;
  const ty = (-minY + pad) * sy;

  // 3. Transform rings into image space.
  const imgRings = allRings.map(r => {
    const out = new Float64Array(r.length);
    for (let i = 0; i < r.length; i += 2) {
      out[i] = r[i] * sx + tx;
      out[i+1] = r[i+1] * sy + ty;
    }
    return out;
  });

  // 4. Rasterize → field.
  const field = rasterizePolygons(imgRings, W, H);

  // 5. Optional bubble blend (blur for soft union).
  if (mergeAll && blurPx > 0) {
    const radius = Math.max(1, Math.round(blurPx * gridRes));
    boxBlur(field, W, H, radius, 2);
  }

  // 6. Marching squares.
  const imgRingsOut = marchingSquares(field, W, H, mergeAll && blurPx > 0 ? 90 : 128);

  // 7. World-space SVG path + ring data for downstream 3D meshing.
  const d = ringsToPath(imgRingsOut, sx, sy, tx, ty, decimateEps);

  // Convert rings to world-space Float32Arrays so the main thread can
  // triangulate without redoing the inverse transform.
  const worldRings = [];
  for (const r of imgRingsOut) {
    let dec = decimateEps > 0 ? rdp(r, decimateEps) : r;
    if (dec.length < 6) continue;
    const w = new Float32Array(dec.length);
    for (let i = 0; i < dec.length; i += 2) {
      w[i]     = (dec[i] - tx) / sx;
      w[i + 1] = (dec[i + 1] - ty) / sy;
    }
    worldRings.push(w);
  }

  return { d, bbox: [minX, minY, maxX, maxY], rings: worldRings };
}

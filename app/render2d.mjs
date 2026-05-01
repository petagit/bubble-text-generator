// 2D-mode helpers: rasterize the worker-produced SVG path string to a 2D
// canvas (so MediaRecorder.captureStream can record it), apply the user's
// pan/zoom/rotate "camera" as a transform on both the SVG group and the
// recording canvas, and interpolate user-authored keyframes for animated
// recording.
//
// These helpers are intentionally framework-free and DOM-light so they can
// be unit-tested under `node --test` like the rest of the helpers in this
// repo.

const DEG = 180 / Math.PI;

// Identity view: no pan, no rotation, scale 1. Use this as the default and
// also as the "Reset view" target.
export const IDENTITY_VIEW_2D = Object.freeze({ tx: 0, ty: 0, scale: 1, rot: 0 });

// Build the SVG transform attribute for the viewGroup. The order is chosen
// so scale and rotation orbit the visual center of the viewBox while `tx/ty`
// is a pure pan in viewBox units. SVG applies these right-to-left.
export function svgTransformFor(view, viewBox) {
  const v = view || IDENTITY_VIEW_2D;
  const { cx, cy } = viewBoxCenter(viewBox);
  const rotDeg = (v.rot || 0) * DEG;
  return (
    `translate(${cx + (v.tx || 0)} ${cy + (v.ty || 0)}) ` +
    `rotate(${rotDeg}) scale(${v.scale || 1}) ` +
    `translate(${-cx} ${-cy})`
  );
}

export function applyView2D(viewGroupEl, view, viewBox) {
  if (!viewGroupEl) return;
  viewGroupEl.setAttribute('transform', svgTransformFor(view, viewBox));
}

function viewBoxCenter(viewBox) {
  const [minX, minY, w, h] = viewBox || [0, 0, 1, 1];
  return { cx: minX + w / 2, cy: minY + h / 2 };
}

// Returns the affine [a, b, c, d, e, f] matrix equivalent to svgTransformFor.
// Useful for canvas `ctx.setTransform()` and for unit tests.
export function mat2DFor(view, viewBox) {
  const v = view || IDENTITY_VIEW_2D;
  const { cx, cy } = viewBoxCenter(viewBox);
  const s = v.scale || 1;
  const r = v.rot || 0;
  const c = Math.cos(r);
  const sn = Math.sin(r);
  // M = T(cx+tx, cy+ty) * R(r) * S(s) * T(-cx, -cy)
  // Combined linear part: scale-then-rotate
  const a = s * c;
  const b = s * sn;
  const cc = -s * sn;
  const d = s * c;
  // Translation: T(cx+tx, cy+ty) applied to point (-cx, -cy) under linear A
  const tx = cx + (v.tx || 0) + a * -cx + cc * -cy;
  const ty = cy + (v.ty || 0) + b * -cx + d * -cy;
  return [a, b, cc, d, tx, ty];
}

// Inverse of an affine [a,b,c,d,e,f] matrix. Returns null if non-invertible.
export function invertMat2D(m) {
  const [a, b, c, d, e, f] = m;
  const det = a * d - b * c;
  if (!det) return null;
  const ia = d / det;
  const ib = -b / det;
  const ic = -c / det;
  const id = a / det;
  const ie = -(ia * e + ic * f);
  const ifn = -(ib * e + id * f);
  return [ia, ib, ic, id, ie, ifn];
}

export function applyMat2D(m, x, y) {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

// Render `geom = { d, bbox }` to a 2D canvas with the same visual params
// applyToDOM uses for the SVG: solid fill, optional white outline stroke,
// optional soft-shadow blur when 2D shading is on.
//
// `viewBox` is the [minX, minY, width, height] of the SVG viewBox; the canvas
// is sized to `outW × outH` and content is fitted with letterbox-style
// `preserveAspectRatio: xMidYMid meet`. `view` is the camera state.
export function renderToCanvas(canvas, geom, params, view, viewBox, options = {}) {
  if (!canvas || typeof canvas.getContext !== 'function') return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const outW = canvas.width;
  const outH = canvas.height;
  const [minX, minY, vbW, vbH] = viewBox || [0, 0, 1, 1];

  // Background: opaque solid color or transparent.
  ctx.save();
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  if (options.background) {
    ctx.fillStyle = options.background;
    ctx.fillRect(0, 0, outW, outH);
  } else {
    ctx.clearRect(0, 0, outW, outH);
  }
  ctx.restore();

  if (!geom || !geom.d || vbW <= 0 || vbH <= 0) return;

  // viewBox → canvas fit (preserveAspectRatio: xMidYMid meet)
  const fit = Math.min(outW / vbW, outH / vbH);
  const fitTx = (outW - vbW * fit) / 2;
  const fitTy = (outH - vbH * fit) / 2;

  // Camera matrix (in viewBox space)
  const cam = mat2DFor(view, viewBox);

  // Combined transform: canvas-fit * camera * (-viewBox-origin shift)
  // ctx.setTransform takes the matrix in column-major-ish form (a,b,c,d,e,f)
  // representing [[a c e],[b d f]].
  const a = fit * cam[0];
  const b = fit * cam[1];
  const c = fit * cam[2];
  const d = fit * cam[3];
  // Apply camera translation, shift viewBox origin to 0,0, then canvas fit:
  //   final = T(fitTx, fitTy) * S(fit) * cam * T(-minX, -minY)
  const e = fitTx + fit * (cam[0] * -minX + cam[2] * -minY + cam[4]);
  const f = fitTy + fit * (cam[1] * -minX + cam[3] * -minY + cam[5]);
  ctx.setTransform(a, b, c, d, e, f);

  const Path2DCtor = options.Path2D || (typeof Path2D === 'function' ? Path2D : null);
  if (!Path2DCtor) return; // headless tests bail; geometry still validated above
  const path = new Path2DCtor(geom.d);

  // Soft-shadow look (mirrors the SVG `softShadow` filter when 2D shading on).
  if (params && params.threeD && params.merge && params.blur > 0) {
    ctx.filter = `blur(${Math.max(0, +params.blur)}px)`;
  }

  ctx.fillStyle = (params && params.fill) || '#ff2d55';
  ctx.fill(path);

  // Outline (white stroke) — drawn after fill so it sits on top.
  if (params && params.outlineOn && params.outlineW > 0) {
    ctx.filter = 'none';
    ctx.lineWidth = +params.outlineW;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#ffffff';
    ctx.stroke(path);
  }

  // Bubble highlight (radial gradient) — mirrors the SVG `bubbleHi` overlay.
  if (params && params.threeD) {
    ctx.filter = 'none';
    const cx = minX + vbW * 0.35;
    const cy = minY + vbH * 0.25;
    const radius = Math.max(vbW, vbH) * 0.65;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0, 'rgba(255,255,255,0.6)');
    grad.addColorStop(0.4, 'rgba(255,255,255,0.1)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = grad;
    ctx.fill(path);
  }

  ctx.filter = 'none';
}

// Returns a new view that zooms by `factor` (e.g. 1.1 to zoom in) centered
// on the SVG user-space point `(ux, uy)`. The same point under the cursor
// stays put after the zoom.
export function zoomViewAt(view, viewBox, ux, uy, factor, minScale = 0.1, maxScale = 20) {
  const v = view || IDENTITY_VIEW_2D;
  const newScale = Math.max(minScale, Math.min(maxScale, (v.scale || 1) * factor));
  if (newScale === v.scale) return { ...v };
  const M = mat2DFor(v, viewBox);
  const Mi = invertMat2D(M);
  if (!Mi) return { ...v };
  const pre = applyMat2D(Mi, ux, uy);
  const Mnew = mat2DFor({ tx: 0, ty: 0, scale: newScale, rot: v.rot || 0 }, viewBox);
  const projected = applyMat2D(Mnew, pre.x, pre.y);
  return {
    tx: ux - projected.x,
    ty: uy - projected.y,
    scale: newScale,
    rot: v.rot || 0,
  };
}

// Returns a new view rotated so that the user-space point that was at
// `(uPrev*)` under the cursor moves to `(uCur*)` along an arc around the
// viewBox center. Used for shift+drag rotate.
export function rotateViewBetween(view, viewBox, uPrevX, uPrevY, uCurX, uCurY) {
  const v = view || IDENTITY_VIEW_2D;
  const { cx, cy } = viewBoxCenter(viewBox);
  const a0 = Math.atan2(uPrevY - cy, uPrevX - cx);
  const a1 = Math.atan2(uCurY - cy, uCurX - cx);
  return { ...v, rot: (v.rot || 0) + (a1 - a0) };
}

// Returns the value at time `t` (seconds) interpolated linearly between
// keyframes. Keyframes are `[{ time, value }]`; out-of-range times clamp
// to the nearest endpoint. If the array is empty/single, returns `fallback`
// or the lone value.
export function interpolateKeyframes(keyframes, t, fallback = 0) {
  if (!Array.isArray(keyframes) || keyframes.length === 0) return fallback;
  if (keyframes.length === 1) return +keyframes[0].value;
  // Sorted-by-time assumption — caller is responsible for sorting on edit.
  const first = keyframes[0];
  const last = keyframes[keyframes.length - 1];
  if (t <= first.time) return +first.value;
  if (t >= last.time) return +last.value;
  for (let i = 1; i < keyframes.length; i++) {
    const a = keyframes[i - 1];
    const b = keyframes[i];
    if (t <= b.time) {
      const span = b.time - a.time;
      if (span <= 0) return +b.value;
      const u = (t - a.time) / span;
      return +a.value + (+b.value - +a.value) * u;
    }
  }
  return +last.value;
}

// Total duration in seconds = max keyframe time. Returns 0 for empty / single.
export function keyframeDuration(keyframes) {
  if (!Array.isArray(keyframes) || keyframes.length < 2) return 0;
  let max = 0;
  for (const k of keyframes) if (k.time > max) max = k.time;
  return max;
}

// Same idea as `keyframeDuration` but across a `{ trackId: [keyframe...] }`
// map. Used for the multi-track timeline so a clip's length is the longest
// span any animated parameter occupies.
export function tracksDuration(tracks) {
  if (!tracks || typeof tracks !== 'object') return 0;
  let max = 0;
  let count = 0;
  for (const id of Object.keys(tracks)) {
    const arr = tracks[id];
    if (!Array.isArray(arr)) continue;
    count += arr.length;
    for (const k of arr) if (k && k.time > max) max = k.time;
  }
  // A duration of 0 only makes sense when there is real animation (≥2 frames
  // somewhere). Otherwise the recorder uses its static-clip fallback.
  return count >= 2 ? max : 0;
}

// True iff no track has any keyframes at all.
export function tracksAreEmpty(tracks) {
  if (!tracks || typeof tracks !== 'object') return true;
  for (const id of Object.keys(tracks)) {
    if (Array.isArray(tracks[id]) && tracks[id].length > 0) return false;
  }
  return true;
}

// Total keyframe count across all tracks.
export function tracksKeyframeCount(tracks) {
  if (!tracks || typeof tracks !== 'object') return 0;
  let n = 0;
  for (const id of Object.keys(tracks)) {
    if (Array.isArray(tracks[id])) n += tracks[id].length;
  }
  return n;
}

// Build a per-frame parameter overlay by interpolating each track at time `t`.
// Tracks with fewer than 2 keyframes are skipped (the slider's current value
// wins). Returns an object suitable for `Object.assign(params, overlay)`.
export function interpolateTracks(tracks, t, base = {}) {
  const overlay = {};
  if (!tracks || typeof tracks !== 'object') return overlay;
  for (const id of Object.keys(tracks)) {
    const kf = tracks[id];
    if (!Array.isArray(kf) || kf.length === 0) continue;
    if (kf.length === 1) { overlay[id] = +kf[0].value; continue; }
    const fallback = (base && id in base) ? +base[id] : +kf[0].value;
    overlay[id] = interpolateKeyframes(kf, t, fallback);
  }
  return overlay;
}

// Visible track duration: at least `minSeconds`, otherwise one second past the
// last keyframe. Used so the timeline always has some empty space at the end
// for the user to grab when adding a new keyframe. Accepts either a single
// keyframe array or a `{ trackId: [...] }` track map.
export function timelineDuration(keyframesOrTracks, minSeconds = 4) {
  let lastTime = 0;
  if (Array.isArray(keyframesOrTracks)) {
    for (const k of keyframesOrTracks) if (k && k.time > lastTime) lastTime = k.time;
  } else if (keyframesOrTracks && typeof keyframesOrTracks === 'object') {
    for (const id of Object.keys(keyframesOrTracks)) {
      const arr = keyframesOrTracks[id];
      if (!Array.isArray(arr)) continue;
      for (const k of arr) if (k && k.time > lastTime) lastTime = k.time;
    }
  }
  return Math.max(minSeconds, lastTime + 1);
}

// Returns a new keyframe with `time` clamped non-negative and `value` clamped
// to [0, maxValue]. Used during drags so markers can't escape the track.
export function clampKeyframe(k, maxValue = 60) {
  const time = Math.max(0, +k.time || 0);
  const value = Math.max(0, Math.min(maxValue, +k.value || 0));
  return { ...k, time, value };
}

// Compute the union bounding box of a list of `[minX, minY, maxX, maxY]`
// frame bboxes plus padding, returned as `[minX, minY, w, h]` for the SVG
// viewBox.
export function unionViewBox(frameBoxes, pad = 40) {
  if (!frameBoxes || frameBoxes.length === 0) return [0, 0, 1, 1];
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const b of frameBoxes) {
    if (!b) continue;
    if (b[0] < minX) minX = b[0];
    if (b[1] < minY) minY = b[1];
    if (b[2] > maxX) maxX = b[2];
    if (b[3] > maxY) maxY = b[3];
  }
  if (!Number.isFinite(minX)) return [0, 0, 1, 1];
  return [minX - pad, minY - pad, (maxX - minX) + pad * 2, (maxY - minY) + pad * 2];
}

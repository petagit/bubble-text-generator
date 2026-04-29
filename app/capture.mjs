// Image and video capture helpers for the WebGL bubble-text scene.
//
// The browser-side bits (off-screen render, MediaRecorder lifecycle, file
// download triggers) live here so the React page can stay focused on UI
// wiring and so the pure helpers are unit-testable under `node --test`.
//
// `captureImage` and `createVideoRecorder` both operate against an existing
// THREE.WebGLRenderer / canvas — we never construct a renderer ourselves.
// That means callers keep all of their material, lighting, and orbit-control
// state intact: the renderer is briefly resized to the export resolution,
// the frame is read back, and the previous size is restored before the next
// `requestAnimationFrame` runs.

export const ASPECT_OPTIONS = [
  { value: 'free', label: 'Auto' },
  { value: '1:1', label: '1:1' },
  { value: '16:9', label: '16:9' },
  { value: '9:16', label: '9:16' },
  { value: '4:3', label: '4:3' },
];

export const RESOLUTION_OPTIONS = [
  { value: 1280, label: '720p' },
  { value: 1920, label: '1080p' },
  { value: 2560, label: '1440p' },
  { value: 3840, label: '4K' },
];

export const VIDEO_FORMATS = [
  { value: 'mp4', label: 'MP4' },
  { value: 'webm', label: 'WebM' },
];

const ASPECT_RATIOS = Object.freeze({
  free: null,
  '1:1': 1,
  '16:9': 16 / 9,
  '9:16': 9 / 16,
  '4:3': 4 / 3,
  '3:2': 3 / 2,
});

// MediaRecorder bitrate budgets keyed by the user-facing quality tier. The
// recording is intentionally generous — we keep fidelity high here and let
// the optional ffmpeg.wasm transcode dial things down on the way to MP4.
const RECORDER_BITRATES = Object.freeze({
  low: 4_000_000,
  mid: 12_000_000,
  high: 24_000_000,
});

export function aspectRatioForOption(id) {
  if (id == null) return null;
  return Object.prototype.hasOwnProperty.call(ASPECT_RATIOS, id) ? ASPECT_RATIOS[id] : null;
}

// One full rotation of `speed` rad/sec is 2π/speed seconds.
// Returns null for non-positive speeds so callers can branch on "no cycle".
export function rotationCycleSeconds(speed) {
  if (!Number.isFinite(speed) || speed <= 0) return null;
  return (2 * Math.PI) / speed;
}

export function formatElapsed(seconds) {
  const safe = Number.isFinite(seconds) ? Math.max(0, seconds) : 0;
  return `${safe.toFixed(1)}s`;
}

function nowMs() {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

function triggerDownloadHref(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename || 'download';
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  triggerDownloadHref(url, filename);
  // Defer revoke so Safari has time to start the download. 1s mirrors the
  // tested timing in the popcamcode reference; shorter values flake there.
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function downloadDataUrl(dataUrl, filename) {
  triggerDownloadHref(dataUrl, filename);
}

// Render the scene at `resolution` × (resolution / aspectRatio) into the
// existing canvas, read it back as a PNG, then restore the on-screen size.
// When `aspectRatio` is null the rendered size matches the live canvas
// aspect. When `withBackground` is false the alpha channel is preserved
// and the image is auto-cropped to the visible silhouette.
export function captureImage({
  renderer,
  scene,
  camera,
  resolution,
  withBackground,
  backgroundColor,
  aspectRatio = null,
}) {
  if (!renderer || !scene || !camera) {
    throw new Error('captureImage: renderer, scene, and camera are required');
  }
  const canvas = renderer.domElement;
  const prevWidth = canvas.width;
  const prevHeight = canvas.height;
  const prevStyle = canvas.style.cssText;
  const prevBackground = scene.background;
  const prevAspect = camera.aspect;

  const liveAspect = prevWidth > 0 && prevHeight > 0 ? prevWidth / prevHeight : 1;
  const renderAspect = aspectRatio && aspectRatio > 0 ? aspectRatio : liveAspect;
  const w = Math.max(1, Math.round(resolution));
  const h = Math.max(1, Math.round(w / renderAspect));

  scene.background = withBackground && backgroundColor ? backgroundColor : null;

  // Park the canvas off-screen during the resize so a 4K snapshot doesn't
  // briefly take over the layout for the user.
  canvas.style.position = 'fixed';
  canvas.style.left = '-9999px';
  canvas.style.top = '0px';

  renderer.setSize(w, h, false);
  if (typeof camera.updateProjectionMatrix === 'function') {
    camera.aspect = renderAspect;
    camera.updateProjectionMatrix();
  }
  renderer.render(scene, camera);

  let dataUrl;
  let outW = w;
  let outH = h;

  if (withBackground) {
    dataUrl = canvas.toDataURL('image/png');
  } else {
    const cropped = autoCropTransparent(canvas, w, h);
    dataUrl = cropped.dataUrl;
    outW = cropped.width;
    outH = cropped.height;
  }

  renderer.setSize(prevWidth, prevHeight, false);
  if (typeof camera.updateProjectionMatrix === 'function') {
    camera.aspect = prevAspect;
    camera.updateProjectionMatrix();
  }
  canvas.style.cssText = prevStyle;
  scene.background = prevBackground;
  // Re-render at the on-screen size so the visible canvas matches the
  // pre-capture frame; otherwise the next animation tick would show a
  // stretched copy of the export resolution.
  renderer.render(scene, camera);

  return { dataUrl, width: outW, height: outH };
}

// Read the rendered canvas into a 2D context, find the alpha bounding box,
// and emit a PNG of just that region with a small margin. Returns the full
// frame untouched if the scene rendered as fully transparent.
function autoCropTransparent(sourceCanvas, w, h) {
  const tmp = document.createElement('canvas');
  tmp.width = w;
  tmp.height = h;
  const tctx = tmp.getContext('2d');
  tctx.drawImage(sourceCanvas, 0, 0);
  const { data } = tctx.getImageData(0, 0, w, h);

  let minX = w;
  let minY = h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (data[(y * w + x) * 4 + 3] > 0) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0) {
    return { dataUrl: tmp.toDataURL('image/png'), width: w, height: h };
  }

  const cropW = maxX - minX + 1;
  const cropH = maxY - minY + 1;
  const pad = Math.max(10, Math.round(Math.max(cropW, cropH) * 0.05));
  const x0 = Math.max(0, minX - pad);
  const y0 = Math.max(0, minY - pad);
  const x1 = Math.min(w, maxX + 1 + pad);
  const y1 = Math.min(h, maxY + 1 + pad);

  const out = document.createElement('canvas');
  out.width = x1 - x0;
  out.height = y1 - y0;
  out.getContext('2d').drawImage(tmp, x0, y0, x1 - x0, y1 - y0, 0, 0, x1 - x0, y1 - y0);
  return { dataUrl: out.toDataURL('image/png'), width: out.width, height: out.height };
}

// Build a MediaRecorder around `canvas.captureStream(60)`. The returned
// handle exposes `stop()`, an `elapsedSeconds()` ticker, and a `stopped`
// promise that resolves to the final WebM blob and its measured duration.
//
// We probe a few WebM codecs in priority order: VP9 (best quality/byte),
// VP8 (universal fallback), and raw `video/webm` (let the browser pick).
// h264 is skipped intentionally — MediaRecorder support is too uneven, and
// MP4 output is handled by the optional ffmpeg.wasm transcode anyway.
export function createVideoRecorder(canvas, { quality = 'high', mimeType, fps = 60 } = {}) {
  if (!canvas || typeof canvas.captureStream !== 'function') {
    throw new Error('createVideoRecorder: canvas must support captureStream()');
  }
  const stream = canvas.captureStream(fps);
  const bitrate = RECORDER_BITRATES[quality] ?? RECORDER_BITRATES.high;

  const candidates = mimeType ? [mimeType] : [
    'video/webm;codecs=vp9',
    'video/webm;codecs=vp8',
    'video/webm',
  ];
  let chosen = '';
  if (typeof MediaRecorder !== 'undefined' && typeof MediaRecorder.isTypeSupported === 'function') {
    for (const c of candidates) {
      if (MediaRecorder.isTypeSupported(c)) { chosen = c; break; }
    }
  }

  const options = { videoBitsPerSecond: bitrate };
  if (chosen) options.mimeType = chosen;
  const recorder = new MediaRecorder(stream, options);

  const chunks = [];
  recorder.ondataavailable = (e) => {
    if (e && e.data && e.data.size > 0) chunks.push(e.data);
  };

  const startedAt = nowMs();
  let stoppedAt = 0;

  const stopped = new Promise((resolve, reject) => {
    recorder.onstop = () => {
      const blob = new Blob(chunks, { type: 'video/webm' });
      const endedAt = stoppedAt || nowMs();
      const duration = Math.max(0, (endedAt - startedAt) / 1000);
      for (const track of stream.getTracks()) {
        try { track.stop(); } catch (_) { /* releasing the stream is best-effort */ }
      }
      resolve({ blob, duration, mimeType: chosen || 'video/webm' });
    };
    recorder.onerror = (event) => {
      reject(event && event.error ? event.error : new Error('MediaRecorder error'));
    };
  });

  // 100 ms slice keeps the buffer flushing often enough that Stop returns
  // promptly instead of waiting on a long unfinished segment.
  recorder.start(100);

  return {
    stop() {
      if (recorder.state !== 'inactive') {
        stoppedAt = nowMs();
        recorder.stop();
      }
    },
    elapsedSeconds() {
      return (nowMs() - startedAt) / 1000;
    },
    stopped,
    state() { return recorder.state; },
  };
}

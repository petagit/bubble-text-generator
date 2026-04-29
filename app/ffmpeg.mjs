// Lazy-loaded ffmpeg.wasm wrapper used to remux the canvas-recorded WebM
// into MP4 (or a re-scaled WebM) for export.
//
// The page imports this module dynamically — only the first time the user
// hits "Download" — so the ~30 MB wasm core never lands in the initial
// bundle. Once loaded, the FFmpeg instance is cached for subsequent
// downloads in the same session.

import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';

// Pin the core to the same minor as `@ffmpeg/ffmpeg` so the JS API and the
// fetched wasm always agree. Bumping one without the other has historically
// produced silent decoder failures.
const CORE_BASE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';

const TRANSCODE_BITRATES = Object.freeze({
  low: '2M',
  mid: '8M',
  high: '16M',
});

let cachedInstance = null;
let cachedLoad = null;

async function getFFmpeg(onStatus) {
  const onMsg = typeof onStatus === 'function' ? onStatus : () => {};
  if (cachedInstance && cachedLoad) {
    await cachedLoad;
    return cachedInstance;
  }
  const ff = new FFmpeg();
  cachedInstance = ff;
  cachedLoad = (async () => {
    onMsg('Loading converter (~30 MB on first export)…');
    const [coreURL, wasmURL] = await Promise.all([
      toBlobURL(`${CORE_BASE}/ffmpeg-core.js`, 'text/javascript'),
      toBlobURL(`${CORE_BASE}/ffmpeg-core.wasm`, 'application/wasm'),
    ]);
    await ff.load({ coreURL, wasmURL });
  })();
  await cachedLoad;
  return ff;
}

// Build the `-vf` chain used during transcoding. Cropping always runs first
// so the subsequent scale operates on already-trimmed pixels, which keeps
// the scaled output crisp for narrow aspect ratios (e.g. 9:16 on a wide
// canvas). Returns the empty string when no transformation is requested
// — the page coalesces that to `undefined` so ffmpeg runs without `-vf`.
export function buildFilterChain({ aspectRatio, scaleWidth } = {}) {
  const parts = [];
  if (Number.isFinite(aspectRatio) && aspectRatio > 0) {
    // Center-crop to the largest rectangle of the requested aspect that
    // fits inside the input. `min` covers both "wider than" and "taller
    // than" sources without branching, and `\,` escapes the literal comma
    // so the outer filter parser doesn't split on it.
    const ar = Number(aspectRatio.toFixed(6));
    parts.push(
      `crop='min(iw\\,ih*${ar})':'min(ih\\,iw/${ar})':'(iw-ow)/2':'(ih-oh)/2'`,
    );
  }
  if (Number.isFinite(scaleWidth) && scaleWidth > 0) {
    // -2 means "match width, keep height divisible by 2" — required for
    // yuv420p output where both dimensions must be even.
    parts.push(`scale=${Math.round(scaleWidth)}:-2`);
  }
  return parts.join(',');
}

export async function convertVideo(blob, onStatus, options = {}) {
  const onMsg = typeof onStatus === 'function' ? onStatus : () => {};
  const format = options.format === 'webm' ? 'webm' : 'mp4';
  const quality = options.quality && TRANSCODE_BITRATES[options.quality] ? options.quality : 'high';
  const bitrate = TRANSCODE_BITRATES[quality];

  const ffmpeg = await getFFmpeg(onMsg);
  const inputName = 'input.webm';
  const outputName = `output.${format}`;
  const totalDuration = Number.isFinite(options.duration) && options.duration > 0
    ? options.duration
    : 0;

  const onProgress = ({ progress, time }) => {
    let pct = 0;
    if (progress > 0 && progress <= 1) {
      pct = Math.round(progress * 100);
    } else if (time > 0 && totalDuration > 0) {
      pct = Math.round(Math.min(1, (time / 1_000_000) / totalDuration) * 100);
    }
    if (pct > 0) onMsg(`${pct}%`);
  };
  ffmpeg.on('progress', onProgress);

  onMsg('Converting…');
  await ffmpeg.writeFile(inputName, await fetchFile(blob));

  const args = [];
  if (Number.isFinite(options.trimStart) && options.trimStart > 0) {
    args.push('-ss', String(options.trimStart));
  }
  args.push('-i', inputName);
  if (Number.isFinite(options.trimEnd) && options.trimEnd > 0) {
    const start = Number.isFinite(options.trimStart) ? options.trimStart : 0;
    const dur = Math.max(0, options.trimEnd - start);
    if (dur > 0) args.push('-t', String(dur));
  }
  if (options.filters) {
    args.push('-vf', options.filters);
  }
  if (format === 'mp4') {
    // mpeg4 (XviD-style) is what the wasm core ships with — not as efficient
    // as h264 but doesn't require a separately licensed encoder. -q:v maps
    // a fixed quality scale (lower = better) onto our quality tiers.
    args.push('-c:v', 'mpeg4');
    args.push('-q:v', bitrate === '16M' ? '2' : bitrate === '8M' ? '4' : '6');
  } else {
    args.push('-c:v', 'libvpx-vp9');
    args.push('-b:v', bitrate);
  }
  args.push('-pix_fmt', 'yuv420p');
  if (format === 'mp4') args.push('-movflags', '+faststart');
  args.push('-an');
  args.push(outputName);

  let exitCode;
  try {
    exitCode = await ffmpeg.exec(args);
  } finally {
    ffmpeg.off('progress', onProgress);
  }

  if (exitCode !== 0) {
    try { await ffmpeg.deleteFile(inputName); } catch (_) { /* cleanup is best-effort */ }
    throw new Error(`ffmpeg exited with code ${exitCode}`);
  }

  const data = await ffmpeg.readFile(outputName);
  const out = new Blob([new Uint8Array(data)], {
    type: format === 'mp4' ? 'video/mp4' : 'video/webm',
  });

  try { await ffmpeg.deleteFile(inputName); } catch (_) { /* cleanup is best-effort */ }
  try { await ffmpeg.deleteFile(outputName); } catch (_) { /* cleanup is best-effort */ }

  return out;
}

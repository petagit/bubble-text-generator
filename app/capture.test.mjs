import test from 'node:test';
import assert from 'node:assert/strict';

import {
  ASPECT_OPTIONS,
  RESOLUTION_OPTIONS,
  VIDEO_FORMATS,
  aspectRatioForOption,
  formatElapsed,
  rotationCycleSeconds,
} from './capture.mjs';
import { buildFilterChain } from './ffmpeg.mjs';

// `captureImage` and `createVideoRecorder` need a real DOM/WebGL canvas, so
// they're exercised in the browser. Everything below is a pure helper: the
// option tables, the small unit conversions, and the ffmpeg filter builder.

test('ASPECT_OPTIONS leads with "free" and includes the standard square/landscape/portrait', () => {
  const ids = ASPECT_OPTIONS.map((o) => o.value);
  assert.equal(ids[0], 'free');
  for (const id of ['1:1', '16:9', '9:16']) {
    assert.ok(ids.includes(id), `expected ${id} in ASPECT_OPTIONS`);
  }
  for (const opt of ASPECT_OPTIONS) {
    assert.equal(typeof opt.label, 'string');
    assert.notEqual(opt.label.length, 0);
  }
});

test('RESOLUTION_OPTIONS maps 1080p to 1920 numerically', () => {
  const op = RESOLUTION_OPTIONS.find((o) => o.value === 1920);
  assert.ok(op, 'expected a 1920-wide entry');
  assert.match(op.label, /1080p/);
  for (const opt of RESOLUTION_OPTIONS) {
    assert.equal(typeof opt.value, 'number');
    assert.ok(opt.value > 0);
  }
});

test('VIDEO_FORMATS contains exactly mp4 and webm', () => {
  const ids = VIDEO_FORMATS.map((o) => o.value).sort();
  assert.deepEqual(ids, ['mp4', 'webm']);
});

test('aspectRatioForOption resolves named ratios and falls back to null', () => {
  assert.equal(aspectRatioForOption('free'), null);
  assert.equal(aspectRatioForOption('1:1'), 1);
  assert.equal(aspectRatioForOption('16:9'), 16 / 9);
  assert.equal(aspectRatioForOption('9:16'), 9 / 16);
  assert.equal(aspectRatioForOption('4:3'), 4 / 3);
  assert.equal(aspectRatioForOption('not-a-real-ratio'), null);
  assert.equal(aspectRatioForOption(undefined), null);
  assert.equal(aspectRatioForOption(null), null);
});

test('formatElapsed clamps negatives and emits one-decimal seconds', () => {
  assert.equal(formatElapsed(0), '0.0s');
  assert.equal(formatElapsed(1.234), '1.2s');
  assert.equal(formatElapsed(12.99), '13.0s');
  assert.equal(formatElapsed(-3), '0.0s');
  assert.equal(formatElapsed(Number.NaN), '0.0s');
});

test('rotationCycleSeconds returns 2π/speed and rejects non-positive speeds', () => {
  assert.equal(rotationCycleSeconds(1), 2 * Math.PI);
  assert.equal(rotationCycleSeconds(2 * Math.PI), 1);
  assert.equal(rotationCycleSeconds(0), null);
  assert.equal(rotationCycleSeconds(-1), null);
  assert.equal(rotationCycleSeconds(Number.NaN), null);
});

test('buildFilterChain returns the empty string when no transformation is asked for', () => {
  assert.equal(buildFilterChain({}), '');
  assert.equal(buildFilterChain({ aspectRatio: 0 }), '');
  assert.equal(buildFilterChain({ aspectRatio: -1, scaleWidth: -1 }), '');
});

test('buildFilterChain emits scale alone for unconstrained aspect', () => {
  assert.equal(buildFilterChain({ scaleWidth: 1920 }), 'scale=1920:-2');
  assert.equal(buildFilterChain({ scaleWidth: 1280.7 }), 'scale=1281:-2');
});

test('buildFilterChain crops first then scales when both are set', () => {
  const out = buildFilterChain({ aspectRatio: 16 / 9, scaleWidth: 1080 });
  assert.match(out, /^crop=/);
  assert.match(out, /,scale=1080:-2$/);
  // The crop expression must escape the comma so ffmpeg's filter parser
  // doesn't split inside `min(iw, ih*ar)`.
  assert.ok(out.includes('\\,'), 'expected escaped comma inside crop expression');
  // The literal aspect ratio is rounded to 6 decimals; sanity-check the
  // first few digits show up.
  assert.ok(out.includes('1.777778'), `aspect ratio not rendered into filter: ${out}`);
});

test('buildFilterChain handles portrait aspect ratios without flipping the formula', () => {
  const out = buildFilterChain({ aspectRatio: 9 / 16, scaleWidth: 720 });
  assert.match(out, /^crop=/);
  assert.match(out, /,scale=720:-2$/);
  assert.ok(out.includes('0.5625'), `aspect ratio not rendered into filter: ${out}`);
});

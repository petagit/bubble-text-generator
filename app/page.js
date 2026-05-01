'use client';

import { useEffect } from 'react';
import opentype from 'opentype.js';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { buildBalloonMesh as buildBalloonMeshFromRings } from './mesh.mjs';
import {
  HDR_PRESETS,
  MATERIAL_PRESETS,
  applyMaterialPreset,
  buildRoomEnvironment,
  createBalloonMaterial,
  createRendererOptions,
  disposeEnvEntry,
  fitCameraToBox,
  getHdrPreset,
  getMaterialPreset,
  glossToClearcoatRoughness,
  glossToRoughness,
  loadHdrEnvironment,
  rotationStep,
} from './rendering.mjs';
import { svgTextToPolys } from './svg-paths.mjs';
import {
  IDENTITY_VIEW_2D,
  applyView2D,
  clampKeyframe,
  interpolateTracks,
  renderToCanvas,
  rotateViewBetween,
  timelineDuration,
  tracksDuration,
  tracksKeyframeCount,
  unionViewBox,
  zoomViewAt,
} from './render2d.mjs';
import {
  ASPECT_OPTIONS,
  RESOLUTION_OPTIONS,
  VIDEO_FORMATS,
  aspectRatioForOption,
  captureImage as captureImageFromScene,
  createVideoRecorder,
  downloadBlob,
  downloadDataUrl,
  formatElapsed,
  rotationCycleSeconds,
} from './capture.mjs';

export default function Page() {
  useEffect(() => {
    const $ = (id) => document.getElementById(id);
    const status = (m) => { $('status').textContent = m; };
    const setSpin = (on) => $('spin').classList.toggle('on', on);

    /* ============================================================
       THREE.JS scene
       ============================================================ */
    const canvas = $('three');
    const renderer = new THREE.WebGLRenderer(createRendererOptions(canvas));
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.05;

    const scene = new THREE.Scene();
    scene.background = null;

    const pmrem = new THREE.PMREMGenerator(renderer);
    pmrem.compileEquirectangularShader();

    // Cache of loaded environments keyed by HDR preset id, each entry holds
    // both the PMREM-filtered env map (for reflections) and the raw equirect
    // texture (for the optional sky background).
    const envCache = new Map();
    const studioEnv = buildRoomEnvironment(pmrem);
    envCache.set('studio', studioEnv);
    let currentHdrId = HDR_PRESETS[0].id;
    let showEnvironment = false;
    scene.environment = studioEnv.envMap;

    const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 5000);
    camera.position.set(0, 0, 800);

    const controls = new OrbitControls(camera, canvas);
    controls.enableDamping = true;
    controls.dampingFactor = 0.08;
    controls.minDistance = 50;
    controls.maxDistance = 4000;

    const dir = new THREE.DirectionalLight(0xffffff, 0.6);
    dir.position.set(2, 3, 4);
    scene.add(dir);
    scene.add(new THREE.AmbientLight(0xffffff, 0.25));

    const material = createBalloonMaterial();

    let currentMesh = null;
    function disposeMesh() {
      if (currentMesh) {
        scene.remove(currentMesh);
        currentMesh.geometry.dispose();
        currentMesh = null;
      }
    }

    function fitCamera(box) {
      fitCameraToBox(camera, controls, box);
    }

    function resize() {
      const w = canvas.clientWidth || 600;
      const h = canvas.clientHeight || 400;
      if (renderer.domElement.width !== w || renderer.domElement.height !== h) {
        renderer.setSize(w, h, false);
        camera.aspect = w / h;
        camera.updateProjectionMatrix();
      }
    }
    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(canvas);
    resize();

    let alive = true;
    let needsRender = true;
    let lastFrameTime = performance.now();
    let recordingActive = false;
    const onControlsChange = () => { needsRender = true; };
    controls.addEventListener('change', onControlsChange);
    function loop(now = performance.now()) {
      if (!alive) return;
      const deltaMs = Math.min(100, Math.max(0, now - lastFrameTime));
      lastFrameTime = now;
      controls.update();
      if ($('autoRotate').checked && currentMesh) {
        currentMesh.rotation.y += rotationStep(+$('rotateSpeed').value, deltaMs);
        needsRender = true;
      }
      // While recording video we need a fresh frame each tick; otherwise
      // captureStream() would just sample the same buffer over and over.
      if (recordingActive) needsRender = true;
      if (needsRender) {
        renderer.render(scene, camera);
        needsRender = false;
      }
      requestAnimationFrame(loop);
    }
    loop();

    /* ============================================================
       3D material / render
       ============================================================ */
    let currentMaterialId = MATERIAL_PRESETS[0].id;
    function applyMaterialFromParams(params) {
      applyMaterialPreset(material, currentMaterialId, params.fill);
      material.roughness = glossToRoughness(params.glossy);
      material.clearcoatRoughness = glossToClearcoatRoughness(params.glossy);
      material.needsUpdate = true;
    }

    function update3D(rings, params) {
      applyMaterialFromParams(params);
      const result = buildBalloonMeshFromRings(rings, params);
      disposeMesh();
      if (!result) { needsRender = true; return; }
      currentMesh = new THREE.Mesh(result.geom, material);
      scene.add(currentMesh);
      fitCamera(result.bbox);
      needsRender = true;
    }

    function set3DColor(col) {
      material.color.set(col);
      needsRender = true;
    }

    function set3DGlossy(g) {
      material.roughness = glossToRoughness(g);
      material.clearcoatRoughness = glossToClearcoatRoughness(g);
      material.needsUpdate = true;
      needsRender = true;
    }

    function updateMaterialButtons() {
      for (const btn of document.querySelectorAll('[data-material-id]')) {
        const selected = btn.dataset.materialId === currentMaterialId;
        btn.classList.toggle('selected', selected);
        btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
      }
    }

    function updateHdrButtons() {
      for (const btn of document.querySelectorAll('[data-hdr-id]')) {
        const id = btn.dataset.hdrId;
        const selected = id === currentHdrId;
        btn.classList.toggle('selected', selected);
        btn.setAttribute('aria-pressed', selected ? 'true' : 'false');
        const cached = envCache.has(id);
        btn.classList.toggle('loading', !cached && btn.classList.contains('loading'));
      }
    }

    function applyEnvironment(entry) {
      scene.environment = entry.envMap;
      // Equirect background is only available for actual HDRIs (RoomEnvironment
      // is a procedural scene with no equirect we can bind as a sky). When the
      // user toggles "Show environment" off, or no equirect exists, clear the
      // background so the CSS gradient shows through the alpha canvas.
      scene.background = showEnvironment && entry.equirect ? entry.equirect : null;
      needsRender = true;
    }

    async function selectHdrPreset(id) {
      const preset = getHdrPreset(id);
      currentHdrId = preset.id;
      updateHdrButtons();

      const cached = envCache.get(preset.id);
      if (cached) {
        applyEnvironment(cached);
        return;
      }
      if (preset.type !== 'hdr' || !preset.url) return;

      const btn = document.querySelector(`[data-hdr-id="${preset.id}"]`);
      btn?.classList.add('loading');
      const prevStatus = $('status').textContent;
      status(`Loading ${preset.name} HDR…`);
      try {
        const entry = await loadHdrEnvironment(preset.url, pmrem);
        envCache.set(preset.id, entry);
        if (currentHdrId === preset.id) applyEnvironment(entry);
        status(prevStatus || 'Ready.');
      } catch (err) {
        status(`HDR load failed: ${err.message}`);
      } finally {
        btn?.classList.remove('loading');
      }
    }

    function syncOutput(id) {
      const out = $(id + 'Val');
      if (out) out.textContent = $(id).value;
    }

    function selectMaterialPreset(id) {
      const preset = getMaterialPreset(id);
      currentMaterialId = preset.id;
      $('fill').value = preset.fill;
      $('glossy').value = String(preset.gloss);
      syncOutput('glossy');
      applyMaterialFromParams(readParams());
      applyStyleOnly();
      updateMaterialButtons();
      needsRender = true;
    }

    /* ============================================================
       CAPTURE — image snapshots and video recording
       ============================================================ */
    let captureMode = 'image';
    let captureAspectId = 'free';
    let captureImageResolution = 1920;
    let captureVideoResolution = 1920;
    let captureWithBackground = true;
    let captureVideoFormat = 'mp4';
    let captureVideoQuality = 'high';
    let captureCycles = null;
    let recorderHandle = null;
    let recorderInterval = 0;
    let recorderAutoStop = 0;
    let lastImageDataUrl = null;
    let lastVideoBlob = null;
    let lastVideoDuration = 0;
    let lastVideoUrl = null;

    // Solid backdrop used when "Include background" is on. Matches the top
    // color of the canvas CSS gradient so the export looks WYSIWYG.
    const captureBgColor = new THREE.Color(0xeef1f6);
    const captureBgColorDark = new THREE.Color(0x1f2228);
    function currentCaptureBackgroundColor() {
      const dark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      return dark ? captureBgColorDark : captureBgColor;
    }

    function setCaptureMode(mode) {
      captureMode = mode;
      for (const btn of document.querySelectorAll('[data-capture-mode]')) {
        btn.classList.toggle('selected', btn.dataset.captureMode === mode);
      }
      const shutter = $('shutter');
      shutter.classList.toggle('shutter-video', mode === 'video');
      shutter.setAttribute('aria-label', mode === 'image' ? 'Take photo' : 'Record video');
      $('cycleChips').hidden = mode !== 'video';
    }

    function setCaptureAspect(id) {
      captureAspectId = id;
      for (const btn of document.querySelectorAll('[data-aspect-id]')) {
        btn.classList.toggle('selected', btn.dataset.aspectId === id);
      }
      // Live-refresh the photo preview so users see the new framing immediately.
      if ($('imageModal').classList.contains('open')) refreshImagePreview(720);
    }

    function setCaptureCycles(n) {
      captureCycles = captureCycles === n ? null : n;
      for (const btn of document.querySelectorAll('[data-cycle]')) {
        btn.classList.toggle('selected', captureCycles !== null && +btn.dataset.cycle === captureCycles);
      }
    }

    // Render the current 2D frame to an off-screen canvas at the chosen
    // resolution and aspect, returning { dataUrl, width, height }. The same
    // renderToCanvas path used during 2D video recording is reused here so
    // the photo and video framings stay identical.
    function captureImage2D(resolution) {
      if (!lastGeom || !lastGeom.d) return null;
      const userAspect = aspectRatioForOption(captureAspectId);
      const vb = currentViewBoxArray();
      const vbAspect = (vb && vb[2] > 0 && vb[3] > 0) ? vb[2] / vb[3] : 1;
      const aspect = (userAspect && userAspect > 0) ? userAspect : vbAspect;
      const W = Math.max(2, Math.round(resolution));
      const H = Math.max(2, Math.round(W / aspect));
      const cv = document.createElement('canvas');
      cv.width = W;
      cv.height = H;
      const bg = captureWithBackground
        ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? '#1f2228' : '#eef1f6')
        : null;
      renderToCanvas(cv, lastGeom, readParams(), view2D, vb, { background: bg });
      return { dataUrl: cv.toDataURL('image/png'), width: W, height: H };
    }

    function refreshImagePreview(resolution = 720) {
      const is3D = $('mode3d').checked;
      const result = is3D
        ? (currentMesh ? captureImageFromScene({
            renderer, scene, camera,
            resolution,
            withBackground: captureWithBackground,
            backgroundColor: currentCaptureBackgroundColor(),
            aspectRatio: aspectRatioForOption(captureAspectId),
          }) : null)
        : captureImage2D(resolution);
      if (!result) return null;
      lastImageDataUrl = result.dataUrl;
      $('imagePreview').src = result.dataUrl;
      needsRender = true;
      return result;
    }

    function openImageModal() {
      const result = refreshImagePreview(720);
      if (!result) {
        const msg = $('mode3d').checked
          ? 'Switch on 3D mode first to capture an image.'
          : 'Type some text first to capture an image.';
        status(msg);
        return;
      }
      $('imageModal').classList.add('open');
    }

    function closeImageModal() {
      $('imageModal').classList.remove('open');
      lastImageDataUrl = null;
    }

    function downloadImageHiRes() {
      const is3D = $('mode3d').checked;
      const result = is3D
        ? captureImageFromScene({
            renderer, scene, camera,
            resolution: captureImageResolution,
            withBackground: captureWithBackground,
            backgroundColor: currentCaptureBackgroundColor(),
            aspectRatio: aspectRatioForOption(captureAspectId),
          })
        : captureImage2D(captureImageResolution);
      if (!result) return;
      needsRender = true;
      const filename = is3D ? 'bubble-text-3d.png' : 'bubble-text.png';
      downloadDataUrl(result.dataUrl, filename);
    }

    function startVideoRecording() {
      if (recorderHandle) return;
      if (!$('mode3d').checked) {
        if (!lastGeom || !lastGeom.d) {
          status('Type some text first to record a video.');
          return;
        }
        startVideoRecording2D();
        return;
      }
      if (!currentMesh) {
        status('Switch on 3D mode first to record a video.');
        return;
      }
      // Match the on-screen background look while recording so the export
      // includes either the solid backdrop or stays transparent.
      scene.background = captureWithBackground ? currentCaptureBackgroundColor() : null;
      renderer.render(scene, camera);

      recordingActive = true;
      $('captureBar').classList.add('recording');
      $('recIndicator').classList.add('open');

      recorderHandle = createVideoRecorder(canvas, { quality: captureVideoQuality });
      const cycleSec = $('autoRotate').checked
        ? rotationCycleSeconds(+$('rotateSpeed').value)
        : null;
      if (captureCycles && cycleSec) {
        const ms = cycleSec * captureCycles * 1000;
        recorderAutoStop = setTimeout(stopVideoRecording, ms);
      }
      recorderInterval = setInterval(() => {
        if (!recorderHandle) return;
        const elapsed = recorderHandle.elapsedSeconds();
        if (captureCycles && cycleSec) {
          const remain = Math.max(0, cycleSec * captureCycles - elapsed);
          $('recElapsed').textContent = formatElapsed(remain);
        } else {
          $('recElapsed').textContent = formatElapsed(elapsed);
        }
      }, 100);

      recorderHandle.stopped.then(({ blob, duration }) => {
        lastVideoBlob = blob;
        lastVideoDuration = duration;
        openVideoReady();
      });
    }

    // Open the post-recording modal with a download-call-to-action highlight.
    // Both the 3D and 2D video paths share this so the reminder is consistent.
    function openVideoReady() {
      if (!lastVideoBlob) return;
      if (lastVideoUrl) URL.revokeObjectURL(lastVideoUrl);
      lastVideoUrl = URL.createObjectURL(lastVideoBlob);
      const v = $('videoPreview');
      v.src = lastVideoUrl;
      v.play().catch(() => {});
      $('videoModal').classList.add('open');
      const banner = $('videoReadyBanner');
      if (banner) banner.classList.remove('hidden');
      const dl = $('videoDownload');
      if (dl) {
        dl.classList.add('attention');
        dl.focus({ preventScroll: true });
      }
      status('Recording ready — tap Download in the preview to save it.');
    }

    function stopVideoRecording() {
      precomputeAborted = true;
      if (recorderAutoStop) { clearTimeout(recorderAutoStop); recorderAutoStop = 0; }
      if (recorderInterval) { clearInterval(recorderInterval); recorderInterval = 0; }
      if (recordPlaybackTimer) { clearTimeout(recordPlaybackTimer); recordPlaybackTimer = 0; }
      if (recorderHandle) recorderHandle.stop();
      recorderHandle = null;
      recordingActive = false;
      $('captureBar').classList.remove('recording');
      $('recIndicator').classList.remove('open');
      // Release the frozen viewBox so 2D editing returns to live framing.
      if (frozenViewBox2D) {
        frozenViewBox2D = null;
        if (lastParams && lastGeom) applyToDOM(lastParams, lastGeom);
      }
      // Restore the on-screen background to whatever the HDR/env state asks for.
      const entry = envCache.get(currentHdrId);
      if (entry) applyEnvironment(entry); else { scene.background = null; needsRender = true; }
    }

    async function downloadVideoExport() {
      if (!lastVideoBlob) return;
      const aspect = aspectRatioForOption(captureAspectId);
      const format = captureVideoFormat;
      const btn = $('videoDownload');
      const labelEl = $('videoDownloadLabel');
      const progressEl = $('videoDownloadProgress');
      const origLabel = labelEl.textContent;
      // Once the user has acted on the download CTA, drop the highlight.
      btn.classList.remove('attention');

      // Fast path: original WebM with no resize/crop needed.
      if (format === 'webm' && !aspect && captureVideoResolution >= 1920) {
        downloadBlob(lastVideoBlob, 'bubble-text-3d.webm');
        return;
      }

      btn.disabled = true;
      progressEl.style.width = '5%';
      try {
        const [{ convertVideo, buildFilterChain }] = await Promise.all([
          import('./ffmpeg.mjs'),
        ]);
        const filters = buildFilterChain({
          aspectRatio: aspect,
          scaleWidth: captureVideoResolution,
        });
        const out = await convertVideo(lastVideoBlob, (msg) => {
          labelEl.textContent = msg;
          const m = /(\d+)%/.exec(msg);
          if (m) progressEl.style.width = `${m[1]}%`;
        }, {
          format,
          quality: captureVideoQuality,
          filters: filters || undefined,
          duration: lastVideoDuration,
        });
        downloadBlob(out, `bubble-text-3d.${format}`);
      } catch (err) {
        console.error('Video export failed', err);
        downloadBlob(lastVideoBlob, 'bubble-text-3d.webm');
      } finally {
        btn.disabled = false;
        labelEl.textContent = origLabel;
        progressEl.style.width = '0%';
      }
    }

    function closeVideoModal() {
      $('videoModal').classList.remove('open');
      const v = $('videoPreview');
      v.pause();
      v.removeAttribute('src');
      v.load();
      if (lastVideoUrl) { URL.revokeObjectURL(lastVideoUrl); lastVideoUrl = null; }
      lastVideoBlob = null;
      lastVideoDuration = 0;
      const dl = $('videoDownload');
      if (dl) dl.classList.remove('attention');
    }

    /* ============================================================
       WORKER
       ============================================================ */
    const worker = new Worker('/worker.js');
    let nextJobId = 1;
    let inflightId = 0;
    let queuedJob = null;
    const jobCallbacks = new Map();

    worker.onmessage = (e) => {
      const { id, ok, error, d, bbox, rings } = e.data;
      const cb = jobCallbacks.get(id);
      jobCallbacks.delete(id);
      if (cb) cb(ok ? { d, bbox, rings } : { error });
      if (id === inflightId) {
        inflightId = 0;
        if (queuedJob) {
          const { msg, transfer, callback } = queuedJob;
          queuedJob = null;
          sendJob(msg, transfer, callback);
        }
      }
    };
    function sendJob(msg, transfer, callback) {
      if (inflightId !== 0) {
        queuedJob = { msg, transfer, callback };
        return;
      }
      const id = nextJobId++;
      inflightId = id;
      msg.id = id;
      jobCallbacks.set(id, callback);
      worker.postMessage(msg, transfer);
    }

    /* ============================================================
       GLYPH FLATTENING
       ============================================================ */
    const FLATTEN_STEPS = 10;
    const glyphCache = new Map();
    let currentFont = null;

    function flattenChar(ch) {
      let entry = glyphCache.get(ch);
      if (entry) return entry;
      if (!currentFont) return null;
      const glyph = currentFont.charToGlyph(ch);
      const path = glyph.getPath(0, 0, 200);
      const cmds = path.commands;
      const polys = [];
      let current = null;
      let cx = 0, cy = 0, sx = 0, sy = 0;
      for (let i = 0; i < cmds.length; i++) {
        const c = cmds[i];
        if (c.type === 'M') {
          if (current && current.length > 4) polys.push(new Float64Array(current));
          current = [cx = sx = c.x, cy = sy = c.y];
        } else if (c.type === 'L') {
          current.push(c.x, c.y); cx = c.x; cy = c.y;
        } else if (c.type === 'Q') {
          const dist = Math.hypot(c.x - cx, c.y - cy);
          const n = Math.max(2, Math.min(FLATTEN_STEPS, Math.ceil(dist / 10)));
          for (let k = 1; k <= n; k++) {
            const t = k / n, u = 1 - t;
            current.push(u*u*cx + 2*u*t*c.x1 + t*t*c.x,
                         u*u*cy + 2*u*t*c.y1 + t*t*c.y);
          }
          cx = c.x; cy = c.y;
        } else if (c.type === 'C') {
          const dist = Math.hypot(c.x - cx, c.y - cy);
          const n = Math.max(2, Math.min(FLATTEN_STEPS, Math.ceil(dist / 10)));
          for (let k = 1; k <= n; k++) {
            const t = k / n, u = 1 - t;
            current.push(u*u*u*cx + 3*u*u*t*c.x1 + 3*u*t*t*c.x2 + t*t*t*c.x,
                         u*u*u*cy + 3*u*u*t*c.y1 + 3*u*t*t*c.y2 + t*t*t*c.y);
          }
          cx = c.x; cy = c.y;
        } else if (c.type === 'Z') {
          cx = sx; cy = sy;
        }
      }
      if (current && current.length > 4) polys.push(new Float64Array(current));
      const advance = (glyph.advanceWidth || currentFont.unitsPerEm * 0.5)
                      * (200 / currentFont.unitsPerEm);
      entry = { polys, advance };
      glyphCache.set(ch, entry);
      return entry;
    }

    /* ============================================================
       PARAMS / RENDER
       ============================================================ */
    let dragging = false;
    let lastRings = null;
    let lastGeom = null;
    let lastParams = null;
    let rafScheduled = false;
    // When an SVG file is uploaded we cache its rings here. While set, the
    // text/font path is bypassed and these polys feed the existing
    // inflate → raster → marching-squares → 3D pipeline as a single "glyph".
    let svgPolys = null;
    let svgFileName = '';

    // 2D camera state mirrors OrbitControls in spirit: drag to pan, wheel to
    // zoom on cursor, shift+drag to rotate around the viewBox center. The
    // same matrix is applied to the SVG #viewGroup and to the recording
    // canvas so a recorded clip reflects whatever framing the user picked.
    let view2D = { ...IDENTITY_VIEW_2D };

    // User-authored animation tracks. One entry per animatable parameter; the
    // active track is the one mouse clicks/drags edit. Each track is sorted
    // by time on mutation. An empty track contributes nothing — the slider's
    // current value wins via the `base` overlay in interpolateTracks.
    const KF_TRACK_DEFS = [
      { id: 'inflate', label: 'Inflate',        color: '#0a84ff', max: 60,  valueOffset: 0,    format: (v) => v.toFixed(0) },
      { id: 'blur',    label: 'Bubble blend',   color: '#ff9f0a', max: 20,  valueOffset: 0,    format: (v) => v.toFixed(0) },
      { id: 'spacing', label: 'Letter spacing', color: '#bf5af2', max: 200, valueOffset: -100, format: (v) => (v - 100).toFixed(0) },
    ];
    const KF_TRACK_BY_ID = Object.fromEntries(KF_TRACK_DEFS.map((t) => [t.id, t]));
    let kfTracks = Object.fromEntries(KF_TRACK_DEFS.map((t) => [t.id, []]));
    let kfActiveTrackId = 'inflate';
    function activeTrackDef() { return KF_TRACK_BY_ID[kfActiveTrackId] || KF_TRACK_DEFS[0]; }
    function activeTrack() { return kfTracks[kfActiveTrackId] || []; }
    // Convert a slider value into / out of the track's value space. Most
    // tracks store the slider value directly; spacing has a -60..60 slider
    // range which we shift into 0..120 so it shares the unsigned [0, max]
    // model the timeline assumes.
    function sliderToTrackValue(id, sliderVal) {
      const def = KF_TRACK_BY_ID[id];
      const off = def && Number.isFinite(def.valueOffset) ? def.valueOffset : 0;
      return +sliderVal - off;
    }
    function trackValueToSlider(id, trackVal) {
      const def = KF_TRACK_BY_ID[id];
      const off = def && Number.isFinite(def.valueOffset) ? def.valueOffset : 0;
      return +trackVal + off;
    }

    // While recording the viewBox is frozen to the union of all pre-rendered
    // frames so that bbox jitter (caused by `merge` blending different
    // numbers of bubbles per frame) doesn't shake the camera.
    let frozenViewBox2D = null;
    let recordPlaybackTimer = 0;
    let precomputeAborted = false;

    function readParams() {
      return {
        text: $('text').value || ' ',
        inflate: +$('inflate').value,
        blur: +$('blur').value,
        spacing: +$('spacing').value,
        merge: $('merge').checked,
        fill: $('fill').value,
        threeD: $('threeD').checked,
        outlineOn: $('outline').checked,
        outlineW: +$('outlineW').value,
        quality: +$('quality').value,
        liveDrag: $('liveDrag').checked,
        mode3d: $('mode3d').checked,
        thickness: +$('thickness').value,
        meshDensity: +$('meshDensity').value,
        glossy: +$('glossy').value,
      };
    }

    function render() {
      // The recording pre-pass owns the worker; suppress interactive renders
      // so the user's slider drags don't overwrite queued frames.
      if (recordingActive) return;
      if (rafScheduled) return;
      rafScheduled = true;
      requestAnimationFrame(() => {
        rafScheduled = false;
        if (!svgPolys && !currentFont) return;
        submitJob();
      });
    }

    function submitJob() {
      const p = readParams();
      let glyphPolys;
      let cursorOffsets;
      if (svgPolys) {
        // SVG mode: route the cached rings as a single "glyph" entry so the
        // worker still sees the same `glyphPolys` / `cursorOffsets` shape it
        // was built around.
        glyphPolys = [svgPolys];
        cursorOffsets = [0];
      } else {
        glyphPolys = [];
        cursorOffsets = [];
        let cursorX = 0;
        for (const ch of p.text) {
          if (ch === ' ') { cursorX += 80 + p.spacing; continue; }
          const entry = flattenChar(ch);
          if (!entry) continue;
          glyphPolys.push(entry.polys);
          cursorOffsets.push(cursorX);
          cursorX += entry.advance + p.spacing;
        }
      }
      if (glyphPolys.length === 0) {
        applyToDOM(p, { d: '', bbox: [0, 0, 1, 1], rings: [] });
        return;
      }
      const liveLow = dragging && p.liveDrag;
      const grid = liveLow ? Math.min(0.9, p.quality) : p.quality;
      const arc = liveLow ? 4 : 8;
      const decim = liveLow ? 0.8 : 0.4;

      const msg = {
        glyphPolys, cursorOffsets,
        inflate: p.inflate,
        arcQuality: arc,
        gridRes: grid,
        blurPx: p.merge ? p.blur : 0,
        mergeAll: p.merge,
        decimateEps: decim,
      };
      setSpin(true);
      const t0 = performance.now();
      sendJob(msg, [], (res) => {
        setSpin(false);
        if (res.error) { status('Error: ' + res.error); return; }
        lastRings = res.rings || [];
        applyToDOM(p, res);
        if (p.mode3d && lastRings.length) {
          update3D(lastRings, p);
        }
        const ms = (performance.now() - t0) | 0;
        status(`Rendered in ${ms} ms${dragging ? ' (drag)' : ''}`);
      });
    }

    function applyToDOM(p, geom) {
      const svg = $('preview');
      lastGeom = geom;
      lastParams = p;
      const pad = 40;
      let viewBoxAttr;
      if (frozenViewBox2D) {
        const [fminX, fminY, fW, fH] = frozenViewBox2D;
        viewBoxAttr = `${fminX} ${fminY} ${fW} ${fH}`;
      } else {
        const [minX, minY, maxX, maxY] = geom.bbox;
        viewBoxAttr = `${minX - pad} ${minY - pad} ${(maxX - minX) + pad*2} ${(maxY - minY) + pad*2}`;
      }
      svg.setAttribute('viewBox', viewBoxAttr);

      const main = $('mainPath');
      main.setAttribute('d', geom.d);
      main.setAttribute('fill', p.fill);

      const defs = $('svgDefs');
      if (p.threeD) {
        if (!defs.querySelector('#bubbleHi')) {
          defs.innerHTML = `
            <radialGradient id="bubbleHi" cx="35%" cy="25%" r="65%">
              <stop offset="0%" stop-color="rgba(255,255,255,0.6)" />
              <stop offset="40%" stop-color="rgba(255,255,255,0.1)" />
              <stop offset="100%" stop-color="rgba(255,255,255,0)" />
            </radialGradient>
            <filter id="softShadow" x="-20%" y="-20%" width="140%" height="140%">
              <feGaussianBlur in="SourceAlpha" stdDeviation="4" />
              <feOffset dx="0" dy="6" result="shadow"/>
              <feComponentTransfer><feFuncA type="linear" slope="0.35"/></feComponentTransfer>
              <feMerge><feMergeNode/><feMergeNode in="SourceGraphic"/></feMerge>
            </filter>`;
        }
        main.setAttribute('filter', 'url(#softShadow)');
        const hi = $('hiPath');
        hi.setAttribute('d', geom.d);
        hi.setAttribute('fill', 'url(#bubbleHi)');
        hi.style.display = '';
      } else {
        main.removeAttribute('filter');
        $('hiPath').style.display = 'none';
      }

      const ol = $('outlinePath');
      if (p.outlineOn && p.outlineW > 0) {
        ol.setAttribute('d', geom.d);
        ol.setAttribute('stroke-width', p.outlineW);
        ol.style.display = '';
      } else {
        ol.style.display = 'none';
      }

      applyView2D($('viewGroup'), view2D, currentViewBoxArray());
    }

    // Read the current SVG viewBox as `[minX, minY, w, h]`.
    function currentViewBoxArray() {
      const vb = $('preview').viewBox.baseVal;
      return [vb.x, vb.y, vb.width, vb.height];
    }

    // Convert a screen pixel coordinate to the SVG's user-space coordinates,
    // accounting for the live `getScreenCTM` (which already includes the
    // viewGroup's transform on its parents — but we want the un-transformed
    // user space inside the SVG, so we use the SVG element's CTM, not the
    // group's).
    function screenPtToSVG(svg, px, py) {
      const pt = svg.createSVGPoint();
      pt.x = px; pt.y = py;
      const ctm = svg.getScreenCTM();
      if (!ctm) return { x: px, y: py };
      const inv = ctm.inverse();
      const out = pt.matrixTransform(inv);
      return { x: out.x, y: out.y };
    }

    // Update view2D and re-apply the SVG transform without recomputing
    // geometry. Cheap enough to call on every pointermove/wheel.
    function setView2D(next) {
      view2D = next;
      const vg = $('viewGroup');
      if (vg) applyView2D(vg, view2D, currentViewBoxArray());
    }

    function resetView2D() {
      setView2D({ ...IDENTITY_VIEW_2D });
    }

    // 2D camera mouse/wheel/keyboard handlers, attached to #preview. Mirrors
    // the OrbitControls feel from 3D mode: drag to pan, wheel to zoom on
    // cursor, shift+drag (or right-button drag) to rotate.
    function setupCamera2D() {
      const svg = $('preview');
      if (!svg) return;

      let panActive = false;
      let rotateActive = false;
      let pointerId = null;
      let startScreenX = 0, startScreenY = 0;
      let startTx = 0, startTy = 0;
      let startRot = 0;
      let startUserX = 0, startUserY = 0;

      const onPointerDown = (e) => {
        // Only steal events when we're in 2D mode; 3D has its own controls
        // on the THREE canvas which sits above when 3D mode is active.
        if ($('mode3d').checked) return;
        if (e.button !== 0 && e.button !== 2) return;
        const rotMode = e.shiftKey || e.button === 2;
        const u = screenPtToSVG(svg, e.clientX, e.clientY);
        startScreenX = e.clientX;
        startScreenY = e.clientY;
        startTx = view2D.tx;
        startTy = view2D.ty;
        startRot = view2D.rot;
        startUserX = u.x;
        startUserY = u.y;
        panActive = !rotMode;
        rotateActive = rotMode;
        pointerId = e.pointerId;
        try { svg.setPointerCapture(pointerId); } catch (_) {}
        e.preventDefault();
      };

      const onPointerMove = (e) => {
        if (!panActive && !rotateActive) return;
        if (e.pointerId !== pointerId) return;
        if (rotateActive) {
          const cur = screenPtToSVG(svg, e.clientX, e.clientY);
          const next = rotateViewBetween(
            { ...view2D, rot: startRot },
            currentViewBoxArray(),
            startUserX, startUserY,
            cur.x, cur.y,
          );
          setView2D({ ...view2D, rot: next.rot });
        } else {
          // Pan in screen pixels, mapped to viewBox units via the SVG's CTM.
          const ctm = svg.getScreenCTM();
          if (!ctm) return;
          const dxScreen = e.clientX - startScreenX;
          const dyScreen = e.clientY - startScreenY;
          setView2D({
            ...view2D,
            tx: startTx + dxScreen / (ctm.a || 1),
            ty: startTy + dyScreen / (ctm.d || 1),
          });
        }
      };

      const onPointerUp = (e) => {
        if (e.pointerId !== pointerId) return;
        panActive = false;
        rotateActive = false;
        try { svg.releasePointerCapture(pointerId); } catch (_) {}
        pointerId = null;
      };

      const onWheel = (e) => {
        if ($('mode3d').checked) return;
        e.preventDefault();
        const u = screenPtToSVG(svg, e.clientX, e.clientY);
        // Negative deltaY = wheel up = zoom in.
        const factor = Math.exp(-e.deltaY * 0.001);
        const next = zoomViewAt(view2D, currentViewBoxArray(), u.x, u.y, factor);
        setView2D(next);
      };

      const onContextMenu = (e) => {
        if (!$('mode3d').checked) e.preventDefault();
      };

      addListener(svg, 'pointerdown', onPointerDown);
      addListener(svg, 'pointermove', onPointerMove);
      addListener(svg, 'pointerup', onPointerUp);
      addListener(svg, 'pointercancel', onPointerUp);
      addListener(svg, 'wheel', onWheel);
      addListener(svg, 'contextmenu', onContextMenu);
    }

    function applyStyleOnly() {
      const p = readParams();
      $('mainPath').setAttribute('fill', p.fill);
      if (p.threeD) {
        $('mainPath').setAttribute('filter', 'url(#softShadow)');
        $('hiPath').style.display = '';
      } else {
        $('mainPath').removeAttribute('filter');
        $('hiPath').style.display = 'none';
      }
      const ol = $('outlinePath');
      if (p.outlineOn && p.outlineW > 0) {
        ol.setAttribute('stroke-width', p.outlineW);
        ol.style.display = '';
      } else {
        ol.style.display = 'none';
      }
      set3DColor(p.fill);
    }

    /* ============================================================
       FONT LOADING
       ============================================================ */
    async function loadFontFromUrl(url) {
      status('Loading font…');
      const res = await fetch(url, { mode: 'cors' });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = await res.arrayBuffer();
      const bytes = new Uint8Array(buf, 0, 4);
      const sig = String.fromCharCode(...bytes);
      const magic = (bytes[0]<<24)|(bytes[1]<<16)|(bytes[2]<<8)|bytes[3];
      const ok = magic === 0x00010000 || sig === 'OTTO' || sig === 'true' || sig === 'typ1' || sig === 'wOFF' || sig === 'wOF2';
      if (!ok) throw new Error('Server returned non-font bytes — upload a .ttf instead.');
      return opentype.parse(buf);
    }
    async function loadFontFromFile(file) {
      return opentype.parse(await file.arrayBuffer());
    }

    /* ============================================================
       EXPORT
       ============================================================ */
    function downloadSvg() {
      const svg = $('preview').cloneNode(true);
      svg.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
      const xml = '<?xml version="1.0" encoding="UTF-8"?>\n' + svg.outerHTML;
      const blob = new Blob([xml], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url; a.download = 'bubble-text.svg'; a.click();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    function downloadPng() {
      const p = readParams();
      if (p.mode3d) {
        const dataURL = $('three').toDataURL('image/png');
        const a = document.createElement('a');
        a.href = dataURL; a.download = 'bubble-text-3d.png'; a.click();
        return;
      }
      const svg = $('preview');
      const xml = new XMLSerializer().serializeToString(svg);
      const blob = new Blob([xml], { type: 'image/svg+xml' });
      const url = URL.createObjectURL(blob);
      const img = new Image();
      img.onload = () => {
        const vb = svg.viewBox.baseVal;
        const scale = 4;
        const cv = document.createElement('canvas');
        cv.width = Math.round(vb.width * scale);
        cv.height = Math.round(vb.height * scale);
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        URL.revokeObjectURL(url);
        cv.toBlob(b => {
          const u = URL.createObjectURL(b);
          const a = document.createElement('a');
          a.href = u; a.download = 'bubble-text.png'; a.click();
          setTimeout(() => URL.revokeObjectURL(u), 1000);
        });
      };
      img.src = url;
    }

    /* ============================================================
       KEYFRAME ANIMATION (2D mode)
       ============================================================ */
    function updateKeyframeStats() {
      const stats = $('keyframeStats');
      if (!stats) return;
      const total = tracksKeyframeCount(kfTracks);
      const dur = tracksDuration(kfTracks);
      if (total === 0) {
        stats.textContent = 'No keyframes — record will capture a 2-second static clip.';
      } else if (dur <= 0) {
        stats.textContent = `${total} keyframe${total === 1 ? '' : 's'} — record will capture a 2-second static clip.`;
      } else {
        const frames = Math.ceil(dur * 30);
        stats.textContent = `${total} keyframe${total === 1 ? '' : 's'} · ${dur.toFixed(2)}s · ${frames} frames @ 30fps`;
      }
    }

    // Timeline geometry. Everything is computed in CSS pixels and the SVG
    // uses a 1:1 viewBox (preserveAspectRatio="xMinYMin meet") so circles,
    // strokes, and text all render at their natural pixel size regardless
    // of the panel's width or height.
    const KF_PAD_LEFT_PX = 38;     // room for axis labels (e.g. "200")
    const KF_PAD_RIGHT_PX = 12;
    const KF_PAD_TOP_PX = 10;
    const KF_PAD_BOTTOM_PX = 22;   // room for "0s 1s 2s …" labels
    const KF_MARKER_R_PX = 6;
    let kfSelectedIndex = -1;
    let kfDraggingIndex = -1;
    let kfDidDrag = false;
    let kfPlayheadTime = -1;

    function sortTrack(arr) { arr.sort((a, b) => a.time - b.time); }

    function timelinePixelMetrics(svg) {
      const def = activeTrackDef();
      const dur = timelineDuration(kfTracks, 4);
      const W = Math.max(80, svg.clientWidth || 280);
      const H = Math.max(60, svg.clientHeight || 140);
      const plotW = Math.max(1, W - KF_PAD_LEFT_PX - KF_PAD_RIGHT_PX);
      const plotH = Math.max(1, H - KF_PAD_TOP_PX - KF_PAD_BOTTOM_PX);
      const max = def.max;
      const timeToX = (t) => KF_PAD_LEFT_PX + (t / dur) * plotW;
      const valueToY = (v) => KF_PAD_TOP_PX + (1 - v / max) * plotH;
      const xToTime = (x) => ((x - KF_PAD_LEFT_PX) / plotW) * dur;
      const yToValue = (y) => (1 - (y - KF_PAD_TOP_PX) / plotH) * max;
      return { dur, W, H, plotW, plotH, timeToX, valueToY, xToTime, yToValue, def };
    }

    // Convert a screen pointer event into (time, value) for the active track,
    // clamped to legal ranges.
    function timelineEventCoords(svg, ev) {
      const rect = svg.getBoundingClientRect();
      const px = ev.clientX - rect.left;
      const py = ev.clientY - rect.top;
      const m = timelinePixelMetrics(svg);
      const time = Math.max(0, Math.min(m.dur, m.xToTime(px)));
      const value = Math.max(0, Math.min(m.def.max, m.yToValue(py)));
      return { time, value };
    }

    function renderKeyframeTimeline() {
      const svg = $('kfTimeline');
      if (!svg) return;
      const m = timelinePixelMetrics(svg);
      const { dur, W, H, timeToX, valueToY, def } = m;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.setAttribute('preserveAspectRatio', 'xMinYMin meet');

      let html = '';

      // Grid: vertical second markers + tick labels along the bottom.
      for (let s = 0; s <= Math.floor(dur); s++) {
        const x = timeToX(s);
        html += `<line class="kf-grid" x1="${x}" y1="${KF_PAD_TOP_PX}" x2="${x}" y2="${H - KF_PAD_BOTTOM_PX}" />`;
        html += `<text class="kf-axis-label" x="${x}" y="${H - 6}" text-anchor="middle">${s}s</text>`;
      }
      // Horizontal value lines for the active track: 0, mid, max (in track
      // units). Labels show the user-facing slider value, so e.g. spacing
      // shows "-100 / 0 / 100" rather than "0 / 100 / 200".
      const ticks = [0, def.max / 2, def.max];
      for (const v of ticks) {
        const y = valueToY(v);
        html += `<line class="kf-grid" x1="${KF_PAD_LEFT_PX}" y1="${y}" x2="${W - KF_PAD_RIGHT_PX}" y2="${y}" />`;
        const display = def.format ? def.format(v) : `${v}`;
        html += `<text class="kf-axis-label" x="${KF_PAD_LEFT_PX - 6}" y="${y + 4}" text-anchor="end">${display}</text>`;
      }

      // Inactive tracks: faint curves so the user can see them but not edit.
      for (const id of Object.keys(kfTracks)) {
        if (id === kfActiveTrackId) continue;
        const trackDef = KF_TRACK_BY_ID[id];
        const arr = kfTracks[id];
        if (!trackDef || arr.length < 2) continue;
        // Map this track's value into the active track's pixel space so the
        // curves visually line up across switches.
        const ratio = trackDef.max > 0 ? def.max / trackDef.max : 1;
        const pts = arr.map((k) => `${timeToX(k.time)},${valueToY(k.value * ratio)}`).join(' ');
        html += `<polyline class="kf-curve kf-curve-inactive" stroke="${trackDef.color}" points="${pts}" />`;
      }

      // Active track curve.
      const active = activeTrack();
      if (active.length >= 2) {
        const pts = active.map((k) => `${timeToX(k.time)},${valueToY(k.value)}`).join(' ');
        html += `<polyline class="kf-curve" stroke="${def.color}" points="${pts}" />`;
      }

      // Markers — only for the active track.
      for (let i = 0; i < active.length; i++) {
        const k = active[i];
        const cls = i === kfSelectedIndex ? 'kf-marker selected' : 'kf-marker';
        html += `<circle class="${cls}" data-i="${i}" cx="${timeToX(k.time)}" cy="${valueToY(k.value)}" r="${KF_MARKER_R_PX}" fill="${def.color}" />`;
      }

      // Playhead.
      if (kfPlayheadTime >= 0) {
        const x = timeToX(kfPlayheadTime);
        html += `<line class="kf-playhead" x1="${x}" y1="${KF_PAD_TOP_PX}" x2="${x}" y2="${H - KF_PAD_BOTTOM_PX}" />`;
      }

      svg.innerHTML = html;

      // Show/hide the delete button based on selection.
      const del = $('kfDelete');
      if (del) del.hidden = kfSelectedIndex < 0;
    }

    function renderKeyframeTrackChips() {
      const host = $('kfTrackChips');
      if (!host) return;
      let html = '';
      for (const def of KF_TRACK_DEFS) {
        const count = (kfTracks[def.id] || []).length;
        const cls = def.id === kfActiveTrackId ? 'kf-track-chip selected' : 'kf-track-chip';
        html += `<button type="button" class="${cls}" data-track="${def.id}" style="--kf-chip-color:${def.color}">${def.label}<span class="kf-track-count">${count}</span></button>`;
      }
      host.innerHTML = html;
    }

    function setActiveTrack(id) {
      if (!KF_TRACK_BY_ID[id] || id === kfActiveTrackId) return;
      kfActiveTrackId = id;
      kfSelectedIndex = -1;
      renderKeyframeTrackChips();
      renderKeyframeTimeline();
      updateKeyframeStats();
    }

    function addKeyframeAtCurrent() {
      const def = activeTrackDef();
      const arr = activeTrack();
      const lastTime = arr.length ? arr[arr.length - 1].time : -1;
      const time = lastTime < 0 ? 0 : Math.round((lastTime + 1) * 100) / 100;
      const slider = $(def.id);
      const trackVal = sliderToTrackValue(def.id, slider ? slider.value : 0);
      arr.push(clampKeyframe({ time, value: trackVal }, def.max));
      sortTrack(arr);
      kfSelectedIndex = arr.findIndex((k) => k.time === time && k.value === trackVal);
      renderKeyframeTrackChips();
      renderKeyframeTimeline();
      updateKeyframeStats();
    }

    function clearKeyframes() {
      // Clear only the active track — Cmd-clearing one param shouldn't nuke
      // the user's other animations.
      kfTracks[kfActiveTrackId] = [];
      kfSelectedIndex = -1;
      renderKeyframeTrackChips();
      renderKeyframeTimeline();
      updateKeyframeStats();
    }

    function deleteSelectedKeyframe() {
      const arr = activeTrack();
      if (kfSelectedIndex < 0 || kfSelectedIndex >= arr.length) return;
      arr.splice(kfSelectedIndex, 1);
      kfSelectedIndex = -1;
      renderKeyframeTrackChips();
      renderKeyframeTimeline();
      updateKeyframeStats();
    }

    function setupTimelinePointer() {
      const svg = $('kfTimeline');
      if (!svg) return;
      let pointerId = null;
      let dragStartT = 0, dragStartV = 0;
      const onDown = (ev) => {
        const target = ev.target;
        if (target && target.classList && target.classList.contains('kf-marker')) {
          const i = +target.getAttribute('data-i');
          if (Number.isInteger(i)) {
            kfDraggingIndex = i;
            kfDidDrag = false;
            kfSelectedIndex = i;
            const { time, value } = timelineEventCoords(svg, ev);
            dragStartT = time; dragStartV = value;
            pointerId = ev.pointerId;
            try { svg.setPointerCapture(pointerId); } catch (_) {}
            renderKeyframeTimeline();
            ev.preventDefault();
            return;
          }
        }
        // Empty-space click: add a keyframe at the cursor on the active track.
        const def = activeTrackDef();
        const arr = kfTracks[kfActiveTrackId];
        const { time, value } = timelineEventCoords(svg, ev);
        arr.push(clampKeyframe({ time, value }, def.max));
        sortTrack(arr);
        kfSelectedIndex = arr.findIndex((k) => k.time === time && k.value === value);
        kfDraggingIndex = kfSelectedIndex;
        kfDidDrag = false;
        pointerId = ev.pointerId;
        try { svg.setPointerCapture(pointerId); } catch (_) {}
        renderKeyframeTrackChips();
        renderKeyframeTimeline();
        updateKeyframeStats();
        ev.preventDefault();
      };
      const onMove = (ev) => {
        if (kfDraggingIndex < 0 || ev.pointerId !== pointerId) return;
        const { time, value } = timelineEventCoords(svg, ev);
        if (Math.abs(time - dragStartT) > 0.01 || Math.abs(value - dragStartV) > 0.5) kfDidDrag = true;
        const def = activeTrackDef();
        const arr = kfTracks[kfActiveTrackId];
        const k = arr[kfDraggingIndex];
        if (!k) return;
        const next = clampKeyframe({ ...k, time, value }, def.max);
        arr[kfDraggingIndex] = next;
        renderKeyframeTimeline();
        updateKeyframeStats();
      };
      const onUp = (ev) => {
        if (ev.pointerId !== pointerId) return;
        // Re-sort (drag may have crossed a neighbor) and recover the selected
        // index by identity, on the active track.
        if (kfDraggingIndex >= 0) {
          const arr = kfTracks[kfActiveTrackId];
          const dragged = arr[kfDraggingIndex];
          sortTrack(arr);
          kfSelectedIndex = arr.indexOf(dragged);
        }
        kfDraggingIndex = -1;
        try { svg.releasePointerCapture(pointerId); } catch (_) {}
        pointerId = null;
        renderKeyframeTimeline();
      };
      addListener(svg, 'pointerdown', onDown);
      addListener(svg, 'pointermove', onMove);
      addListener(svg, 'pointerup', onUp);
      addListener(svg, 'pointercancel', onUp);
    }

    // Convert an interpolateTracks() overlay (track-space values) into a
    // submitJobAsync paramOverride (slider-space values) and a side-effect
    // map for keeping the sliders in sync during preview.
    function trackOverlayToSliderOverride(overlay) {
      const override = {};
      const sliders = {};
      for (const id of Object.keys(overlay)) {
        const sliderVal = trackValueToSlider(id, overlay[id]);
        override[id] = sliderVal;
        sliders[id] = sliderVal;
      }
      return { override, sliders };
    }

    function applyTrackPreviewSliders(sliders) {
      for (const id of Object.keys(sliders)) {
        const def = KF_TRACK_BY_ID[id];
        const slider = $(id);
        if (!slider) continue;
        slider.value = sliders[id];
        const out = $(`${id}Val`);
        if (out && def && typeof def.format === 'function') {
          // The format helper takes track-space values; we have slider-space
          // here, so reverse the offset before formatting.
          out.textContent = def.format(sliderToTrackValue(id, sliders[id]));
        }
      }
    }

    function snapshotSliders(ids) {
      const out = {};
      for (const id of ids) {
        const slider = $(id);
        out[id] = slider ? +slider.value : 0;
      }
      return out;
    }

    let timelinePlayActive = false;
    let timelinePlayTimer = 0;
    let timelinePlayBusy = false;
    async function previewTimeline() {
      if (timelinePlayActive) return;
      const dur = tracksDuration(kfTracks);
      if (dur <= 0) {
        status('Add at least two keyframes on a track to preview the timeline.');
        return;
      }
      const ids = KF_TRACK_DEFS.map((d) => d.id);
      const original = snapshotSliders(ids);
      const baseTrack = {};
      for (const id of ids) baseTrack[id] = sliderToTrackValue(id, original[id]);
      const frameMs = 1000 / 30;
      const startedAt = performance.now();
      timelinePlayActive = true;
      $('kfPlay').textContent = '■ Stop preview';
      const tick = async () => {
        if (!timelinePlayActive) return;
        if (timelinePlayBusy) {
          timelinePlayTimer = setTimeout(tick, frameMs);
          return;
        }
        const t = (performance.now() - startedAt) / 1000;
        kfPlayheadTime = t;
        renderKeyframeTimeline();
        if (t >= dur) {
          stopTimelinePreview(original);
          return;
        }
        const overlay = interpolateTracks(kfTracks, t, baseTrack);
        const { override, sliders } = trackOverlayToSliderOverride(overlay);
        timelinePlayBusy = true;
        try {
          const res = await submitJobAsync(override);
          if (!timelinePlayActive) return;
          applyTrackPreviewSliders(sliders);
          lastRings = res.rings || [];
          applyToDOM(res.params, res);
        } finally {
          timelinePlayBusy = false;
        }
        timelinePlayTimer = setTimeout(tick, frameMs);
      };
      tick();
    }

    function stopTimelinePreview(restoreValues) {
      timelinePlayActive = false;
      kfPlayheadTime = -1;
      renderKeyframeTimeline();
      if (timelinePlayTimer) { clearTimeout(timelinePlayTimer); timelinePlayTimer = 0; }
      const btn = $('kfPlay');
      if (btn) btn.textContent = '▶ Preview';
      if (restoreValues && typeof restoreValues === 'object') {
        applyTrackPreviewSliders(restoreValues);
        render();
      }
    }

    /* ============================================================
       2D VIDEO RECORDING (keyframe-driven, pre-rendered)
       ============================================================ */
    // Promise wrapper around the worker job so we can `await` per-frame
    // geometry during the pre-compute pass. Forces high-quality settings
    // regardless of `liveDrag`.
    function submitJobAsync(paramOverride) {
      return new Promise((resolve, reject) => {
        const p = readParams();
        if (paramOverride) Object.assign(p, paramOverride);
        let glyphPolys;
        let cursorOffsets;
        if (svgPolys) {
          glyphPolys = [svgPolys];
          cursorOffsets = [0];
        } else {
          glyphPolys = [];
          cursorOffsets = [];
          let cursorX = 0;
          for (const ch of p.text) {
            if (ch === ' ') { cursorX += 80 + p.spacing; continue; }
            const entry = flattenChar(ch);
            if (!entry) continue;
            glyphPolys.push(entry.polys);
            cursorOffsets.push(cursorX);
            cursorX += entry.advance + p.spacing;
          }
        }
        if (glyphPolys.length === 0) {
          resolve({ d: '', bbox: [0, 0, 1, 1], rings: [], params: p });
          return;
        }
        const msg = {
          glyphPolys, cursorOffsets,
          inflate: p.inflate,
          arcQuality: 8,
          gridRes: p.quality,
          blurPx: p.merge ? p.blur : 0,
          mergeAll: p.merge,
          decimateEps: 0.4,
        };
        sendJob(msg, [], (res) => {
          if (res.error) reject(new Error(res.error));
          else resolve({ ...res, params: p });
        });
      });
    }

    async function preRender2DFrames() {
      const baseDuration = tracksDuration(kfTracks);
      const haveKeyframes = baseDuration > 0;
      const ids = KF_TRACK_DEFS.map((d) => d.id);
      const sliderBase = snapshotSliders(ids);
      const trackBase = {};
      for (const id of ids) trackBase[id] = sliderToTrackValue(id, sliderBase[id]);
      const duration = haveKeyframes ? baseDuration * (captureCycles || 1) : 2;
      const fps = 30;
      const frameCount = Math.max(1, Math.ceil(duration * fps));
      const frames = [];
      precomputeAborted = false;

      const indicator = $('recElapsed');
      const initialIndicator = indicator ? indicator.textContent : '';
      for (let i = 0; i < frameCount; i++) {
        if (precomputeAborted) return null;
        const t = i / fps;
        // Wrap into the base clip's timebase when looping for cycles >1.
        const tWrap = haveKeyframes ? (t % baseDuration) : 0;
        const overlay = haveKeyframes ? interpolateTracks(kfTracks, tWrap, trackBase) : {};
        const { override } = trackOverlayToSliderOverride(overlay);
        // eslint-disable-next-line no-await-in-loop
        const res = await submitJobAsync(override);
        frames.push({ d: res.d, bbox: res.bbox, params: res.params });
        if (indicator) indicator.textContent = `Rendering ${i + 1}/${frameCount}`;
      }
      if (indicator) indicator.textContent = initialIndicator;
      return { frames, fps, duration };
    }

    async function startVideoRecording2D() {
      if (recorderHandle) return;
      const recordCanvas = $('record2d');
      if (!recordCanvas) {
        status('Recording canvas missing.');
        return;
      }

      $('captureBar').classList.add('recording');
      $('recIndicator').classList.add('open');
      recordingActive = true;

      let result;
      try {
        result = await preRender2DFrames();
      } catch (err) {
        status('Render failed: ' + err.message);
        recordingActive = false;
        $('captureBar').classList.remove('recording');
        $('recIndicator').classList.remove('open');
        return;
      }
      if (!result || precomputeAborted) {
        recordingActive = false;
        $('captureBar').classList.remove('recording');
        $('recIndicator').classList.remove('open');
        return;
      }

      const { frames, fps } = result;
      // Convert each frame's [minX,minY,maxX,maxY] to the same form the SVG
      // viewBox uses — but the union helper expects [minX,minY,maxX,maxY] so
      // we pass straight in.
      const frozenViewBox = unionViewBox(frames.map((f) => f.bbox), 40);
      frozenViewBox2D = frozenViewBox;

      // Size the record canvas. If the user picked an aspect chip, honour it;
      // otherwise fall back to the geometry's frozen viewBox aspect so "Auto"
      // tracks the silhouette. renderToCanvas uses preserveAspectRatio:meet,
      // so the geometry is letterboxed inside whatever frame we set here.
      const targetW = captureVideoResolution || 1920;
      const userAspect = aspectRatioForOption(captureAspectId);
      const aspect = (userAspect && userAspect > 0)
        ? userAspect
        : (frozenViewBox[2] / frozenViewBox[3] || 1);
      recordCanvas.width = Math.max(2, Math.round(targetW));
      recordCanvas.height = Math.max(2, Math.round(targetW / aspect));

      // Background color (mirrors the photo path's WYSIWYG behaviour).
      const bgColor = captureWithBackground
        ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? '#1f2228' : '#eef1f6')
        : null;

      // Paint the first frame so MediaRecorder's first sample isn't blank.
      renderToCanvas(recordCanvas, frames[0], frames[0].params, view2D, frozenViewBox, { background: bgColor });

      recorderHandle = createVideoRecorder(recordCanvas, { quality: captureVideoQuality, fps });
      let frameIndex = 0;
      const frameMs = 1000 / fps;
      let lastFrameAt = performance.now();
      const paint = () => {
        if (!recorderHandle) return;
        const f = frames[frameIndex];
        renderToCanvas(recordCanvas, f, f.params, view2D, frozenViewBox, { background: bgColor });
        frameIndex++;
        if (frameIndex >= frames.length) {
          // Allow the last frame a full slot before stopping so the recorder
          // captures it. Mirror the elapsed timer one final time.
          recordPlaybackTimer = setTimeout(() => stopVideoRecording(), frameMs);
          return;
        }
        const now = performance.now();
        const drift = now - lastFrameAt - frameMs;
        lastFrameAt = now;
        recordPlaybackTimer = setTimeout(paint, Math.max(0, frameMs - drift));
      };
      lastFrameAt = performance.now();
      recordPlaybackTimer = setTimeout(paint, frameMs);

      recorderInterval = setInterval(() => {
        if (!recorderHandle) return;
        const elapsed = recorderHandle.elapsedSeconds();
        $('recElapsed').textContent = formatElapsed(elapsed);
      }, 100);

      recorderHandle.stopped.then(({ blob, duration }) => {
        lastVideoBlob = blob;
        lastVideoDuration = duration;
        openVideoReady();
      });
    }

    /* ============================================================
       WIRING
       ============================================================ */
    const cleanups = [];
    const addListener = (el, ev, fn) => {
      el.addEventListener(ev, fn);
      cleanups.push(() => el.removeEventListener(ev, fn));
    };

    // Toggle the disabled state of a form control along with its surrounding
    // wrapper so the label dims too. We pick the nearest enclosing <label> or
    // <div>, never both, to avoid dimming an entire panel when a single
    // checkbox is its own label.
    function setControlDisabled(id, disabled) {
      const el = $(id);
      if (!el) return;
      el.disabled = disabled;
      el.setAttribute('aria-disabled', disabled ? 'true' : 'false');
      const wrap = el.closest('label, div');
      if (wrap) wrap.classList.toggle('disabled-row', disabled);
    }

    // Recompute which controls are inapplicable to the current source/mode
    // combination. Called whenever the user changes 3D mode, uploads an SVG,
    // or clears it.
    function applyControlAvailability() {
      const mode3d = $('mode3d').checked;
      const inSvgMode = svgPolys != null;

      // SVG source mode hides text-only inputs because no text is being laid
      // out — the SVG's own paths drive the silhouette.
      setControlDisabled('text', inSvgMode);
      setControlDisabled('font', inSvgMode);
      setControlDisabled('builtin', inSvgMode);
      setControlDisabled('spacing', inSvgMode);

      // 2D-only style controls only affect the SVG preview, so they are
      // meaningless once the user has switched to the 3D balloon view.
      setControlDisabled('threeD', mode3d);
      setControlDisabled('outline', mode3d);
      setControlDisabled('outlineW', mode3d);

      // Conversely, the 3D-only knobs (thickness, gloss, environment, etc.)
      // do nothing when the user is staring at the flat SVG, so dim them out.
      setControlDisabled('thickness', !mode3d);
      setControlDisabled('meshDensity', !mode3d);
      setControlDisabled('glossy', !mode3d);
      setControlDisabled('autoRotate', !mode3d);
      setControlDisabled('rotateSpeed', !mode3d);
      setControlDisabled('showEnv', !mode3d);
      for (const btn of document.querySelectorAll('[data-material-id], [data-hdr-id]')) {
        btn.disabled = !mode3d;
        btn.setAttribute('aria-disabled', !mode3d ? 'true' : 'false');
      }

      // Reveal the "clear svg" affordance only while there is something to
      // clear; otherwise it would just sit there confusingly.
      const clearBtn = $('svgClear');
      if (clearBtn) clearBtn.style.display = inSvgMode ? '' : 'none';
      const nameLabel = $('svgFileName');
      if (nameLabel) nameLabel.textContent = inSvgMode ? svgFileName : '';
    }

    const styleOnlyIds = ['fill', 'threeD', 'outline', 'outlineW'];
    const geomIds      = ['text', 'inflate', 'blur', 'spacing', 'merge', 'quality',
                          'thickness', 'meshDensity'];

    for (const id of styleOnlyIds) addListener($(id), 'input', applyStyleOnly);
    for (const id of geomIds)      addListener($(id), 'input', render);
    addListener($('liveDrag'), 'change', render);

    addListener($('glossy'), 'input', () => {
      set3DGlossy(+$('glossy').value);
    });

    addListener($('autoRotate'), 'change', () => {
      lastFrameTime = performance.now();
      needsRender = true;
    });
    addListener($('rotateSpeed'), 'input', () => {
      needsRender = true;
    });
    for (const btn of document.querySelectorAll('[data-material-id]')) {
      addListener(btn, 'click', () => selectMaterialPreset(btn.dataset.materialId));
    }
    updateMaterialButtons();

    for (const btn of document.querySelectorAll('[data-hdr-id]')) {
      addListener(btn, 'click', () => { selectHdrPreset(btn.dataset.hdrId); });
    }
    updateHdrButtons();
    applyControlAvailability();
    setupCamera2D();

    addListener($('showEnv'), 'change', () => {
      showEnvironment = $('showEnv').checked;
      const entry = envCache.get(currentHdrId);
      if (entry) applyEnvironment(entry);
    });

    addListener($('mode3d'), 'change', () => {
      document.body.classList.toggle('mode3d-on', $('mode3d').checked);
      applyControlAvailability();
      if ($('mode3d').checked && lastRings && lastRings.length) {
        update3D(lastRings, readParams());
      }
    });

    let dragEndTimer = null;
    for (const id of ['inflate', 'blur', 'spacing', 'outlineW', 'quality', 'thickness', 'meshDensity', 'glossy', 'rotateSpeed']) {
      const el = $(id);
      addListener(el, 'pointerdown', () => { dragging = true; });
      addListener(el, 'keydown', () => { dragging = true; });
      const endDrag = () => {
        dragging = false;
        clearTimeout(dragEndTimer);
        dragEndTimer = setTimeout(render, 16);
      };
      addListener(el, 'pointerup', endDrag);
      addListener(el, 'pointercancel', endDrag);
      addListener(el, 'blur', endDrag);
      addListener(el, 'keyup', endDrag);
      const out = $(id + 'Val');
      if (out) {
        const sync = () => out.textContent = el.value;
        addListener(el, 'input', sync);
        sync();
      }
    }

    addListener($('builtin'), 'change', async (e) => {
      setSpin(true);
      try {
        currentFont = await loadFontFromUrl(e.target.value);
        glyphCache.clear();
        status('Ready.');
        render();
      } catch (err) { status('Font load failed: ' + err.message); }
      finally { setSpin(false); }
    });
    addListener($('font'), 'change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      setSpin(true);
      try {
        currentFont = await loadFontFromFile(f);
        glyphCache.clear();
        status('Loaded ' + f.name);
        render();
      } catch (err) { status('Font parse failed: ' + err.message); }
      finally { setSpin(false); }
    });
    addListener($('svgFile'), 'change', async (e) => {
      const f = e.target.files[0];
      if (!f) return;
      setSpin(true);
      try {
        const text = await f.text();
        const polys = svgTextToPolys(text);
        if (!polys || polys.length === 0) {
          throw new Error('no fillable shapes found — make sure the SVG has filled <path>, <rect>, <circle>, etc.');
        }
        svgPolys = polys;
        svgFileName = f.name;
        applyControlAvailability();
        status('SVG mode: ' + f.name);
        render();
      } catch (err) {
        status('SVG load failed: ' + (err && err.message ? err.message : err));
      } finally { setSpin(false); }
    });
    addListener($('svgClear'), 'click', () => {
      svgPolys = null;
      svgFileName = '';
      const fileEl = $('svgFile');
      if (fileEl) fileEl.value = '';
      applyControlAvailability();
      status(currentFont ? 'Back to text mode.' : 'Back to text mode (load a font to render).');
      render();
    });
    addListener($('dlSvg'), 'click', downloadSvg);
    addListener($('dlPng'), 'click', downloadPng);

    // 2D camera + keyframe controls
    if ($('resetView2D')) addListener($('resetView2D'), 'click', resetView2D);
    if ($('kfAdd')) addListener($('kfAdd'), 'click', addKeyframeAtCurrent);
    if ($('kfClear')) addListener($('kfClear'), 'click', clearKeyframes);
    if ($('kfDelete')) addListener($('kfDelete'), 'click', deleteSelectedKeyframe);
    if ($('kfPlay')) addListener($('kfPlay'), 'click', () => {
      if (timelinePlayActive) stopTimelinePreview(undefined);
      else previewTimeline();
    });
    setupTimelinePointer();
    if ($('kfTrackChips')) {
      addListener($('kfTrackChips'), 'click', (ev) => {
        const btn = ev.target && ev.target.closest('[data-track]');
        if (btn) setActiveTrack(btn.dataset.track);
      });
    }
    renderKeyframeTrackChips();
    renderKeyframeTimeline();
    updateKeyframeStats();
    // Re-render on resize so markers/labels stay round under non-uniform aspect.
    const kfSvg = $('kfTimeline');
    if (kfSvg && typeof ResizeObserver !== 'undefined') {
      const kfRO = new ResizeObserver(() => renderKeyframeTimeline());
      kfRO.observe(kfSvg);
    }

    // Capture wiring
    setCaptureMode('image');
    setCaptureAspect('free');
    addListener($('shutter'), 'click', () => {
      if (captureMode === 'image') openImageModal();
      else if (recorderHandle) stopVideoRecording();
      else startVideoRecording();
    });
    for (const btn of document.querySelectorAll('[data-capture-mode]')) {
      addListener(btn, 'click', () => setCaptureMode(btn.dataset.captureMode));
    }
    for (const btn of document.querySelectorAll('[data-aspect-id]')) {
      addListener(btn, 'click', () => setCaptureAspect(btn.dataset.aspectId));
    }
    for (const btn of document.querySelectorAll('[data-cycle]')) {
      addListener(btn, 'click', () => setCaptureCycles(+btn.dataset.cycle));
    }
    addListener($('recStop'), 'click', stopVideoRecording);
    addListener($('imageDiscard'), 'click', closeImageModal);
    addListener($('imageDownload'), 'click', downloadImageHiRes);
    addListener($('imageRes'), 'change', (e) => { captureImageResolution = +e.target.value; });
    addListener($('imageBg'), 'change', (e) => {
      captureWithBackground = e.target.checked;
      refreshImagePreview(720);
    });
    addListener($('videoDiscard'), 'click', closeVideoModal);
    addListener($('videoDownload'), 'click', downloadVideoExport);
    addListener($('videoRes'), 'change', (e) => { captureVideoResolution = +e.target.value; });
    addListener($('videoQuality'), 'change', (e) => { captureVideoQuality = e.target.value; });
    addListener($('videoFormat'), 'change', (e) => { captureVideoFormat = e.target.value; });
    for (const closer of document.querySelectorAll('[data-modal-close]')) {
      addListener(closer, 'click', () => {
        if ($('imageModal').classList.contains('open')) closeImageModal();
        if ($('videoModal').classList.contains('open')) closeVideoModal();
      });
    }
    const onKeyDown = (e) => {
      if (e.key !== 'Escape') return;
      if ($('imageModal').classList.contains('open')) closeImageModal();
      else if ($('videoModal').classList.contains('open')) closeVideoModal();
      else if (recorderHandle) stopVideoRecording();
    };
    window.addEventListener('keydown', onKeyDown);
    cleanups.push(() => window.removeEventListener('keydown', onKeyDown));

    (async () => {
      setSpin(true);
      try {
        currentFont = await loadFontFromUrl($('builtin').value);
        status('Ready.');
        render();
      } catch (e) {
        status('Default font failed: ' + e.message);
      } finally { setSpin(false); }
    })();

    return () => {
      alive = false;
      worker.terminate();
      resizeObserver.disconnect();
      controls.removeEventListener('change', onControlsChange);
      controls.dispose();
      for (const c of cleanups) c();
      disposeMesh();
      if (recorderHandle) recorderHandle.stop();
      if (recorderInterval) clearInterval(recorderInterval);
      if (recorderAutoStop) clearTimeout(recorderAutoStop);
      if (lastVideoUrl) URL.revokeObjectURL(lastVideoUrl);
      for (const entry of envCache.values()) disposeEnvEntry(entry);
      envCache.clear();
      scene.environment = null;
      scene.background = null;
      pmrem.dispose();
      renderer.dispose();
      document.body.classList.remove('mode3d-on');
    };
  }, []);

  return (
    <>
      <aside>
        <div>
          <h1>Bubble Text Generator</h1>
          <div className="sub">Procedural inflate of any font</div>
        </div>

        <div>
          <label htmlFor="text">Text</label>
          <input id="text" type="text" defaultValue="POPCAM" autoComplete="off" />
        </div>

        <div>
          <label htmlFor="font">Font (.ttf / .otf)</label>
          <input id="font" type="file" accept=".ttf,.otf,.woff" />
          <div className="hint">Or pick a built-in heavy font below.</div>
        </div>

        <div>
          <label htmlFor="builtin">Built-in font</label>
          <select id="builtin" defaultValue="https://raw.githubusercontent.com/google/fonts/main/ofl/bagelfatone/BagelFatOne-Regular.ttf">
            <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/bagelfatone/BagelFatOne-Regular.ttf">Bagel Fat One (very puffy)</option>
            <option value="https://raw.githubusercontent.com/google/fonts/main/apache/luckiestguy/LuckiestGuy-Regular.ttf">Luckiest Guy</option>
            <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/sniglet/Sniglet-Regular.ttf">Sniglet</option>
            <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/bungee/Bungee-Regular.ttf">Bungee</option>
            <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/bowlbyonesc/BowlbyOneSC-Regular.ttf">Bowlby One SC</option>
            <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/passionone/PassionOne-Black.ttf">Passion One Black</option>
            <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/changaone/ChangaOne-Regular.ttf">Changa One</option>
            <option value="https://raw.githubusercontent.com/google/fonts/main/ofl/orbitron/Orbitron%5Bwght%5D.ttf">Orbitron</option>
          </select>
        </div>

        <div>
          <label htmlFor="svgFile">Or upload an SVG</label>
          <input id="svgFile" type="file" accept=".svg,image/svg+xml" />
          <div className="svg-row">
            <span id="svgFileName" className="hint" />
            <button id="svgClear" type="button" className="secondary svg-clear">Clear SVG</button>
          </div>
          <div className="hint">Replaces the text input. Filled shapes (paths, rects, circles…) get inflated and rendered through the same 2D / 3D pipeline.</div>
        </div>

        <hr />

        <div>
          <div className="row"><label htmlFor="inflate">Inflate</label><span className="val" id="inflateVal">14</span></div>
          <input id="inflate" type="range" min="0" max="60" defaultValue="14" />
        </div>

        <div>
          <div className="row"><label htmlFor="blur">Bubble blend</label><span className="val" id="blurVal">3</span></div>
          <input id="blur" type="range" min="0" max="20" defaultValue="3" />
          <div className="hint">Higher = letters merge into a softer single blob.</div>
        </div>

        <div>
          <div className="row"><label htmlFor="spacing">Letter spacing</label><span className="val" id="spacingVal">-30</span></div>
          <input id="spacing" type="range" min="-100" max="100" defaultValue="-30" />
        </div>

        <div>
          <label className="checkbox"><input id="merge" type="checkbox" defaultChecked /> Soft-blend touching letters</label>
        </div>

        <hr />

        <details open>
          <summary>3D balloon</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <label className="checkbox"><input id="mode3d" type="checkbox" /> 3D mode (drag to rotate, scroll to zoom)</label>
            <div>
              <div className="row"><label htmlFor="thickness">Thickness</label><span className="val" id="thicknessVal">0.55</span></div>
              <input id="thickness" type="range" min="0.1" max="1.5" step="0.05" defaultValue="0.55" />
            </div>
            <div>
              <div className="row"><label htmlFor="meshDensity">Mesh density</label><span className="val" id="meshDensityVal">14</span></div>
              <input id="meshDensity" type="range" min="6" max="28" step="1" defaultValue="14" />
              <div className="hint">Smaller triangles = smoother surface, slower.</div>
            </div>
            <div>
              <div className="row"><label htmlFor="glossy">Gloss</label><span className="val" id="glossyVal">0.85</span></div>
              <input id="glossy" type="range" min="0" max="1" step="0.05" defaultValue="0.85" />
            </div>
            <div>
              <label className="checkbox"><input id="autoRotate" type="checkbox" /> Auto rotate</label>
            </div>
            <div>
              <div className="row"><label htmlFor="rotateSpeed">Rotation speed</label><span className="val" id="rotateSpeedVal">0.8</span></div>
              <input id="rotateSpeed" type="range" min="0.1" max="3" step="0.1" defaultValue="0.8" />
            </div>
            <div>
              <label>Material</label>
              <div className="material-grid">
                {MATERIAL_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="material-chip"
                    data-material-id={preset.id}
                    aria-pressed={preset.id === MATERIAL_PRESETS[0].id ? 'true' : 'false'}
                    title={preset.name}
                  >
                    <span className="material-swatch" style={{ background: preset.fill }} />
                    <span>{preset.name}</span>
                  </button>
                ))}
              </div>
              <div className="hint">Mirror + Chrome reflect the HDR environment below.</div>
            </div>
            <div>
              <label>Environment (HDR)</label>
              <div className="hdr-grid">
                {HDR_PRESETS.map((preset) => (
                  <button
                    key={preset.id}
                    type="button"
                    className="hdr-chip"
                    data-hdr-id={preset.id}
                    aria-pressed={preset.id === HDR_PRESETS[0].id ? 'true' : 'false'}
                    title={preset.hint || preset.name}
                  >
                    <span className="hdr-swatch" style={{ background: preset.swatch }} />
                    <span>{preset.name}</span>
                  </button>
                ))}
              </div>
              <label className="checkbox" style={{ marginTop: 8 }}>
                <input id="showEnv" type="checkbox" /> Show environment as background
              </label>
            </div>
          </div>
        </details>

        <details>
          <summary>Style</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <div>
              <label htmlFor="fill">Fill</label>
              <input id="fill" type="color" defaultValue="#ff2d55" />
            </div>
            <label className="checkbox"><input id="threeD" type="checkbox" defaultChecked /> 2D shading (highlight + shadow)</label>
            <label className="checkbox"><input id="outline" type="checkbox" /> White outline</label>
            <div>
              <div className="row"><label htmlFor="outlineW">Outline width</label><span className="val" id="outlineWVal">8</span></div>
              <input id="outlineW" type="range" min="0" max="30" defaultValue="8" />
            </div>
          </div>
        </details>

        <details>
          <summary>Quality</summary>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10, marginTop: 10 }}>
            <div>
              <div className="row"><label htmlFor="quality">Resolution</label><span className="val" id="qualityVal">1.5</span></div>
              <input id="quality" type="range" min="0.5" max="3" step="0.1" defaultValue="1.5" />
            </div>
            <label className="checkbox"><input id="liveDrag" type="checkbox" defaultChecked /> Lower quality while dragging</label>
          </div>
        </details>

        <div className="btn-row">
          <button id="dlSvg">Download SVG</button>
          <button id="dlPng" className="secondary">Download PNG</button>
        </div>
        <div className="hint" id="status">Loading default font…</div>
      </aside>
      <main>
        <div id="stage">
          <svg className="preview" id="preview" xmlns="http://www.w3.org/2000/svg" preserveAspectRatio="xMidYMid meet">
            <defs id="svgDefs"></defs>
            <g id="viewGroup">
              <path id="mainPath" />
              <path id="outlinePath" fill="none" stroke="#fff" strokeLinejoin="round" strokeLinecap="round" />
              <path id="hiPath" />
            </g>
          </svg>
          <canvas id="three"></canvas>
          <canvas id="record2d" hidden width="1920" height="1920"></canvas>
          <button id="resetView2D" type="button" className="reset-view" aria-label="Reset 2D view">Reset view</button>
          <div className="spinner" id="spin"></div>
        </div>
        <div id="captureBar" className="capture-bar" aria-label="Capture controls">
          <div id="cycleChips" className="cycle-pill" hidden>
            {[1, 2, 3].map((n) => (
              <button key={n} type="button" className="cycle-chip" data-cycle={n} title={`Repeat ${n}× (rotation cycles in 3D, keyframe loops in 2D)`}>
                <span aria-hidden="true">↻</span>{n}x
              </button>
            ))}
          </div>
          <button id="shutter" type="button" className="shutter" aria-label="Take photo">
            <span className="shutter-ring" />
            <span className="shutter-dot" />
          </button>
          <div className="capture-pill">
            <button type="button" className="cap-tab" data-capture-mode="image">Image</button>
            <button type="button" className="cap-tab" data-capture-mode="video">Video</button>
            <span className="cap-divider" />
            {ASPECT_OPTIONS.map((opt) => (
              <button key={opt.value} type="button" className="aspect-chip" data-aspect-id={opt.value}>{opt.label}</button>
            ))}
          </div>
          <div className="capture-hint">Photo + video work in both 2D and 3D modes.</div>
        </div>
        <section id="kfPanel" className="kf-panel" aria-label="Animation keyframes">
          <div className="kf-panel-head">
            <strong>Animation keyframes (2D record)</strong>
            <div id="kfTrackChips" className="kf-track-chips" role="tablist" aria-label="Animated parameter" />
            <span className="hint" id="keyframeStats">No keyframes — record will capture a 2-second static clip.</span>
          </div>
          <div className="kf-panel-body">
            <svg id="kfTimeline" className="kf-timeline" preserveAspectRatio="none" xmlns="http://www.w3.org/2000/svg" />
            <div className="kf-panel-actions">
              <button id="kfAdd" type="button">+ Add at current</button>
              <button id="kfPlay" type="button" className="secondary">▶ Preview</button>
              <button id="kfClear" type="button" className="secondary">Clear track</button>
              <button id="kfDelete" type="button" className="secondary" hidden>Delete keyframe</button>
              <span className="hint kf-panel-hint">Pick a track above · click to add · drag to move · X = time</span>
            </div>
          </div>
        </section>
      </main>

      <div id="recIndicator" className="rec-indicator" aria-live="polite">
        <span className="rec-dot" />
        <span id="recElapsed" className="rec-elapsed">0.0s</span>
        <button id="recStop" type="button" className="rec-stop">
          <span className="rec-stop-square" /> Stop
        </button>
      </div>

      <div id="imageModal" className="modal" role="dialog" aria-modal="true" aria-labelledby="imageModalTitle">
        <div className="modal-backdrop" data-modal-close />
        <div className="modal-card">
          <div className="modal-header">
            <div id="imageModalTitle" className="modal-title">Photo preview</div>
            <button type="button" className="modal-close" data-modal-close aria-label="Close">×</button>
          </div>
          <div className="modal-image checker">
            <img id="imagePreview" alt="Captured 3D bubble text" />
          </div>
          <div className="modal-controls">
            <label className="modal-field">
              <span>Resolution</span>
              <select id="imageRes" defaultValue="1920">
                {RESOLUTION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="modal-field checkbox">
              <input id="imageBg" type="checkbox" defaultChecked /> Include background
            </label>
          </div>
          <div className="modal-actions">
            <button id="imageDiscard" type="button" className="secondary">Discard</button>
            <button id="imageDownload" type="button">Download PNG</button>
          </div>
        </div>
      </div>

      <div id="videoModal" className="modal" role="dialog" aria-modal="true" aria-labelledby="videoModalTitle">
        <div className="modal-backdrop" data-modal-close />
        <div className="modal-card">
          <div className="modal-header">
            <div id="videoModalTitle" className="modal-title">Video preview</div>
            <button type="button" className="modal-close" data-modal-close aria-label="Close">×</button>
          </div>
          <div className="modal-video">
            <video id="videoPreview" controls loop muted playsInline />
          </div>
          <div id="videoReadyBanner" className="modal-banner" role="status">
            ✓ Recording ready — pick a format below, then tap <strong>Download</strong> to save.
          </div>
          <div className="modal-controls">
            <label className="modal-field">
              <span>Resolution</span>
              <select id="videoRes" defaultValue="1920">
                {RESOLUTION_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>{o.label}</option>
                ))}
              </select>
            </label>
            <label className="modal-field">
              <span>Quality</span>
              <select id="videoQuality" defaultValue="high">
                <option value="low">Low</option>
                <option value="mid">Mid</option>
                <option value="high">High</option>
              </select>
            </label>
            <label className="modal-field">
              <span>Format</span>
              <select id="videoFormat" defaultValue="mp4">
                {VIDEO_FORMATS.map((f) => (
                  <option key={f.value} value={f.value}>{f.label}</option>
                ))}
              </select>
            </label>
          </div>
          <div className="modal-actions">
            <button id="videoDiscard" type="button" className="secondary">Discard</button>
            <button id="videoDownload" type="button" className="progress-btn">
              <span id="videoDownloadProgress" className="progress-fill" />
              <span id="videoDownloadLabel" className="progress-label">Download</span>
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

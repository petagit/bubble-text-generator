import assert from 'node:assert/strict';
import test from 'node:test';

import * as THREE from 'three';

import {
  HDR_PRESETS,
  MATERIAL_PRESETS,
  applyMaterialPreset,
  createBalloonMaterial,
  createRendererOptions,
  disposeEnvEntry,
  fitCameraToBox,
  getHdrPreset,
  glossToClearcoatRoughness,
  glossToRoughness,
  loadHdrEnvironment,
  rotationStep,
} from './rendering.mjs';

test('fitCameraToBox keeps depth range tight enough to avoid z-fighting', () => {
  const camera = new THREE.PerspectiveCamera(35, 1, 0.01, 5000);
  const controls = { target: new THREE.Vector3(), update() {} };
  const box = new THREE.Box3(
    new THREE.Vector3(-350, -90, -35),
    new THREE.Vector3(350, 90, 35)
  );

  fitCameraToBox(camera, controls, box);

  assert.ok(camera.near >= 1, 'near plane should not stay at the unstable default');
  assert.ok(camera.far / camera.near < 1000, 'near/far ratio should preserve depth precision');
  assert.ok(camera.far > camera.position.z + 35, 'far plane should still contain the mesh');
});

test('createRendererOptions enables high-precision depth buffering', () => {
  const options = createRendererOptions('canvas');

  assert.equal(options.canvas, 'canvas');
  assert.equal(options.antialias, true);
  assert.equal(options.alpha, true);
  assert.equal(options.logarithmicDepthBuffer, true);
});

test('createBalloonMaterial keeps both balloon caps visible', () => {
  const material = createBalloonMaterial();

  assert.equal(material.side, THREE.DoubleSide);
  assert.equal(material.depthTest, true);
  assert.equal(material.depthWrite, true);
});

test('applyMaterialPreset maps palette choices to color and physical material settings', () => {
  const material = createBalloonMaterial();
  const preset = MATERIAL_PRESETS.find((item) => item.id === 'chrome-silver');

  assert.ok(preset, 'expected chrome material preset');

  const fill = applyMaterialPreset(material, preset.id);

  assert.equal(fill, '#c7ccd6');
  assert.equal(material.color.getHexString(), 'c7ccd6');
  assert.equal(material.metalness, 1);
  assert.ok(material.roughness < 0.2);
  assert.equal(material.clearcoat, 1);
});

test('rotationStep converts speed slider values to frame deltas', () => {
  assert.equal(rotationStep(0, 1000), 0);
  assert.equal(rotationStep(1, 1000), 1);
  assert.equal(rotationStep(2.5, 500), 1.25);
});

test('Mirror material preset is a true metallic mirror', () => {
  const preset = MATERIAL_PRESETS.find((item) => item.id === 'mirror');
  assert.ok(preset, 'expected a "mirror" material preset');
  assert.equal(preset.material.metalness, 1);
  assert.equal(preset.material.roughness, 0);
  assert.equal(preset.material.clearcoat, 0,
    'mirror should not stack a dielectric clearcoat over the metal');
  assert.ok(preset.material.envMapIntensity >= 1,
    'mirror should reflect the HDR at full strength or boosted');
});

test('applyMaterialPreset transfers envMapIntensity onto the material', () => {
  const material = createBalloonMaterial();
  material.envMapIntensity = 0.2;
  applyMaterialPreset(material, 'mirror');
  assert.equal(material.envMapIntensity, 1.5,
    'mirror preset should override stale envMapIntensity from a prior preset');
});

test('glossToRoughness reaches a true mirror finish at gloss=1', () => {
  assert.equal(glossToRoughness(1), 0,
    'gloss=1 should resolve to a perfectly smooth surface');
  assert.equal(glossToRoughness(0), 0.95);
  assert.ok(glossToRoughness(0.5) > 0.4 && glossToRoughness(0.5) < 0.5);
  assert.equal(glossToRoughness(2), 0, 'values above 1 should clamp');
  assert.equal(glossToRoughness(-1), 0.95, 'values below 0 should clamp');
});

test('glossToClearcoatRoughness sticks to a thin film at full gloss', () => {
  assert.equal(glossToClearcoatRoughness(1), 0.02);
  assert.equal(glossToClearcoatRoughness(0), 0.52);
});

test('HDR_PRESETS covers the studio default plus several real HDRIs', () => {
  assert.ok(HDR_PRESETS.length >= 3, 'expected at least a few HDR options');
  const studio = HDR_PRESETS.find((item) => item.id === 'studio');
  assert.ok(studio, 'studio preset must exist as the procedural default');
  assert.equal(studio.type, 'room');
  assert.ok(!studio.url, 'studio preset should not require a network download');

  const ids = new Set();
  for (const preset of HDR_PRESETS) {
    assert.ok(preset.id && typeof preset.id === 'string', 'each HDR has an id');
    assert.ok(!ids.has(preset.id), `HDR id ${preset.id} must be unique`);
    ids.add(preset.id);
    assert.ok(preset.name, 'each HDR has a display name');
    assert.ok(preset.swatch, 'each HDR has a CSS swatch for the chip preview');
    if (preset.type === 'hdr') {
      assert.match(preset.url, /\.hdr$/i, 'HDR preset URL must point at a .hdr file');
      assert.match(preset.url, /^https:\/\//,
        'HDR preset URL must be loadable cross-origin from a secure host');
    }
  }
});

test('getHdrPreset falls back to the studio default for unknown ids', () => {
  assert.equal(getHdrPreset('venice-sunset').id, 'venice-sunset');
  assert.equal(getHdrPreset('does-not-exist').id, HDR_PRESETS[0].id);
});

test('loadHdrEnvironment wraps RGBELoader and exposes equirect + env map', async () => {
  const fakeTexture = { mapping: null, dispose() { fakeTexture.disposed = true; } };
  const fakePmrem = {
    fromEquirectangular(eq) {
      assert.equal(eq, fakeTexture);
      assert.equal(eq.mapping, THREE.EquirectangularReflectionMapping,
        'loader must mark the equirect for reflection sampling before PMREM');
      return { texture: { isPMREM: true }, dispose() { this.disposed = true; } };
    },
  };
  const fakeLoader = {
    load(url, onLoad) {
      assert.equal(url, 'https://example.test/env.hdr');
      onLoad(fakeTexture);
    },
  };

  const entry = await loadHdrEnvironment('https://example.test/env.hdr', fakePmrem, {
    loader: fakeLoader,
  });

  assert.equal(entry.equirect, fakeTexture);
  assert.equal(entry.envMap.isPMREM, true);
  assert.ok(entry.renderTarget, 'entry should expose render target for disposal');

  disposeEnvEntry(entry);
  assert.equal(fakeTexture.disposed, true, 'equirect should be disposed');
  assert.equal(entry.renderTarget.disposed, true, 'PMREM RT should be disposed');
});

test('loadHdrEnvironment surfaces RGBELoader errors as Promise rejections', async () => {
  const fakeLoader = {
    load(_url, _onLoad, _onProgress, onError) { onError('boom'); },
  };
  await assert.rejects(
    () => loadHdrEnvironment('x', {}, { loader: fakeLoader }),
    /boom/,
  );
});

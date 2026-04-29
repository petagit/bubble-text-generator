import * as THREE from 'three';
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';

export const MATERIAL_PRESETS = [
  {
    id: 'glossy-pink',
    name: 'Glossy Pink',
    fill: '#ff2d55',
    gloss: 0.85,
    material: {
      metalness: 0.0,
      roughness: 0.25,
      clearcoat: 1.0,
      clearcoatRoughness: 0.08,
      sheen: 0.5,
      sheenRoughness: 0.4,
      reflectivity: 0.6,
      envMapIntensity: 1.0,
    },
  },
  {
    id: 'mirror',
    name: 'Mirror',
    fill: '#ffffff',
    gloss: 1,
    material: {
      metalness: 1.0,
      roughness: 0.0,
      clearcoat: 0.0,
      clearcoatRoughness: 0.0,
      sheen: 0.0,
      sheenRoughness: 0.0,
      reflectivity: 1.0,
      // Boost envMapIntensity so the HDR shows up vividly across the whole
      // surface even where the geometry's normal is glancing. With metalness=1
      // and roughness=0 the BRDF reduces to a pure mirror so the env map IS
      // the visible shading.
      envMapIntensity: 1.5,
    },
  },
  {
    id: 'chrome-silver',
    name: 'Chrome',
    fill: '#c7ccd6',
    gloss: 1,
    material: {
      metalness: 1.0,
      roughness: 0.08,
      clearcoat: 1.0,
      clearcoatRoughness: 0.02,
      sheen: 0.0,
      sheenRoughness: 0.2,
      reflectivity: 1.0,
      envMapIntensity: 1.0,
    },
  },
  {
    id: 'matte-rubber',
    name: 'Matte Rubber',
    fill: '#22252a',
    gloss: 0.15,
    material: {
      metalness: 0.0,
      roughness: 0.88,
      clearcoat: 0.15,
      clearcoatRoughness: 0.75,
      sheen: 0.2,
      sheenRoughness: 0.9,
      reflectivity: 0.25,
      envMapIntensity: 1.0,
    },
  },
  {
    id: 'pearl-white',
    name: 'Pearl',
    fill: '#f4eee2',
    gloss: 0.85,
    material: {
      metalness: 0.0,
      roughness: 0.18,
      clearcoat: 1.0,
      clearcoatRoughness: 0.14,
      sheen: 0.75,
      sheenRoughness: 0.35,
      reflectivity: 0.75,
      envMapIntensity: 1.0,
    },
  },
  {
    id: 'candy-red',
    name: 'Candy Red',
    fill: '#e60023',
    gloss: 0.95,
    material: {
      metalness: 0.0,
      roughness: 0.16,
      clearcoat: 1.0,
      clearcoatRoughness: 0.04,
      sheen: 0.35,
      sheenRoughness: 0.35,
      reflectivity: 0.85,
      envMapIntensity: 1.0,
    },
  },
  {
    id: 'plastic-blue',
    name: 'Plastic Blue',
    fill: '#1677ff',
    gloss: 0.65,
    material: {
      metalness: 0.0,
      roughness: 0.38,
      clearcoat: 0.55,
      clearcoatRoughness: 0.25,
      sheen: 0.25,
      sheenRoughness: 0.55,
      reflectivity: 0.45,
      envMapIntensity: 1.0,
    },
  },
];

// Free HDRIs hosted in the three.js example assets repo. raw.githubusercontent.com
// serves with `Access-Control-Allow-Origin: *`, the same source the app already
// uses for built-in fonts, so they load directly from the browser. The `swatch`
// gradient is a CSS preview that approximates the dominant color of each HDR.
export const HDR_PRESETS = [
  {
    id: 'studio',
    name: 'Studio',
    type: 'room',
    swatch: 'linear-gradient(135deg, #f4f6fb 0%, #c8ccd5 100%)',
    hint: 'Procedural soft-box studio (no download)',
  },
  {
    id: 'venice-sunset',
    name: 'Venice Sunset',
    type: 'hdr',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/equirectangular/venice_sunset_1k.hdr',
    swatch: 'linear-gradient(135deg, #ffb56b 0%, #5a2a52 100%)',
    hint: 'Warm golden hour, strong rim lights',
  },
  {
    id: 'spruit-sunrise',
    name: 'Sunrise',
    type: 'hdr',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/equirectangular/spruit_sunrise_1k.hdr',
    swatch: 'linear-gradient(135deg, #f0d188 0%, #4d6a93 100%)',
    hint: 'Cool blue dawn over a field',
  },
  {
    id: 'pedestrian-overpass',
    name: 'Urban',
    type: 'hdr',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/equirectangular/pedestrian_overpass_1k.hdr',
    swatch: 'linear-gradient(135deg, #8da6ad 0%, #2a2c34 100%)',
    hint: 'Outdoor city, neutral overcast light',
  },
  {
    id: 'quarry',
    name: 'Quarry',
    type: 'hdr',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/equirectangular/quarry_01_1k.hdr',
    swatch: 'linear-gradient(135deg, #d4c8aa 0%, #50473a 100%)',
    hint: 'Open sky over warm rock',
  },
  {
    id: 'moonless-golf',
    name: 'Night',
    type: 'hdr',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/equirectangular/moonless_golf_1k.hdr',
    swatch: 'linear-gradient(135deg, #1d2c46 0%, #050610 100%)',
    hint: 'Dark sky with distant point lights',
  },
  {
    id: 'monochrome-studio',
    name: 'Mono Studio',
    type: 'hdr',
    url: 'https://raw.githubusercontent.com/mrdoob/three.js/master/examples/textures/equirectangular/monochrome_studio_02_1k.hdr',
    swatch: 'linear-gradient(135deg, #fafafa 0%, #1c1c1c 100%)',
    hint: 'High-contrast black & white softboxes',
  },
];

export function getMaterialPreset(id) {
  return MATERIAL_PRESETS.find((preset) => preset.id === id) || MATERIAL_PRESETS[0];
}

export function getHdrPreset(id) {
  return HDR_PRESETS.find((preset) => preset.id === id) || HDR_PRESETS[0];
}

// Maps the gloss slider [0..1] to PBR roughness so that gloss=1 produces a
// true mirror finish (roughness=0). The previous mapping (`1 - g * 0.85`)
// could not reach zero, which made the chrome / mirror presets look frosted
// even at full gloss.
export function glossToRoughness(gloss) {
  const clamped = Math.min(1, Math.max(0, gloss));
  return (1 - clamped) * 0.95;
}

export function glossToClearcoatRoughness(gloss) {
  const clamped = Math.min(1, Math.max(0, gloss));
  return 0.02 + (1 - clamped) * 0.5;
}

export function applyMaterialPreset(material, presetId, fillOverride) {
  const preset = getMaterialPreset(presetId);
  material.color.set(fillOverride || preset.fill);
  Object.assign(material, preset.material);
  material.needsUpdate = true;
  return preset.fill;
}

export function rotationStep(speed, deltaMs) {
  return Math.max(0, speed) * (deltaMs / 1000);
}

export function createRendererOptions(canvas) {
  return {
    canvas,
    antialias: true,
    alpha: true,
    logarithmicDepthBuffer: true,
  };
}

export function createBalloonMaterial() {
  const material = new THREE.MeshPhysicalMaterial({
    side: THREE.DoubleSide,
    depthTest: true,
    depthWrite: true,
  });
  applyMaterialPreset(material, MATERIAL_PRESETS[0].id);
  return material;
}

export function fitCameraToBox(camera, controls, box) {
  const size = new THREE.Vector3();
  box.getSize(size);
  const center = new THREE.Vector3();
  box.getCenter(center);

  const maxDim = Math.max(size.x, size.y, size.z);
  const fitDist = maxDim / (2 * Math.tan((camera.fov * Math.PI) / 360));
  const cameraDistance = fitDist * 1.6;

  camera.position.set(center.x, center.y, center.z + cameraDistance);
  camera.near = Math.max(1, cameraDistance - maxDim * 1.5);
  camera.far = cameraDistance + maxDim * 2.5;
  camera.updateProjectionMatrix();
  camera.lookAt(center);

  controls.target.copy(center);
  controls.update();
}

// Build the procedural soft-box studio environment that ships with three.js.
// Returns the PMREM-processed env map texture and the underlying render
// target so the caller can dispose it later. There's no equirect to expose
// for backgrounds — RoomEnvironment is a 3D scene, not an image.
export function buildRoomEnvironment(pmrem) {
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
  return { envMap: env.texture, equirect: null, renderTarget: env };
}

// Load an .hdr equirectangular image and return both the PMREM-filtered env
// map (for IBL reflections) and the raw equirect texture (so the caller can
// optionally use it as `scene.background`).
export function loadHdrEnvironment(url, pmrem, { loader } = {}) {
  const rgbeLoader = loader || new RGBELoader();
  return new Promise((resolve, reject) => {
    rgbeLoader.load(
      url,
      (equirect) => {
        equirect.mapping = THREE.EquirectangularReflectionMapping;
        const env = pmrem.fromEquirectangular(equirect);
        resolve({ envMap: env.texture, equirect, renderTarget: env });
      },
      undefined,
      (err) => reject(err instanceof Error ? err : new Error(String(err))),
    );
  });
}

export function disposeEnvEntry(entry) {
  if (!entry) return;
  if (entry.renderTarget && typeof entry.renderTarget.dispose === 'function') {
    entry.renderTarget.dispose();
  }
  if (entry.equirect && typeof entry.equirect.dispose === 'function') {
    entry.equirect.dispose();
  }
}

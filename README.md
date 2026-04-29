# Bubble Text Generator

Procedural bubble-text tool that takes any TTF/OTF font, inflates the glyph
silhouettes into balloon shapes, and renders them in 2D (SVG) or 3D
(Three.js, drag to rotate). Built with Next.js (App Router) + pnpm.

## Pipeline

1. **Glyph paths** are extracted with [opentype.js](https://opentype.js.org/)
   and flattened to polygons.
2. A **Web Worker** (`public/worker.js`) does the heavy geometry off the main
   thread:
   - Each polygon is dilated via an analytical right-perpendicular offset
     (outer rings expand, counters shrink → glyph thickens).
   - Letters are rasterized into an alpha bitmap using a non-zero-winding
     scanline fill.
   - Optional Gaussian blur + threshold gives the soft "metaball" merge of
     touching letters.
   - **Marching squares** with linear interpolation + saddle disambiguation
     traces the merged silhouette into closed rings.
3. **2D output** is the SVG path of those rings, with optional drop shadow,
   highlight gradient, and outline stroke.
4. **3D output** triangulates each shape with Delaunator over densified
   boundaries plus a hex-grid of interior Steiner points. Because Delaunator is
   not constrained, triangle edges are filtered so they cannot cross or bridge
   outside the outer ring or through counters. The puff displaces those points
   along Z by `(2t − t²) · thickness` where `t = distance / maxDistance` is the
   normalized inscribed distance. Boundary vertices are shared between the
   front and back caps so the silhouette shades smoothly.
5. Per-vertex Laplacian smoothing on the height field removes
   medial-axis ridges.
6. **Materials** are PBR (`MeshPhysicalMaterial`). Presets cover glossy plastic,
   chrome, matte rubber, pearl, candy paint, and a true **mirror finish**
   (`metalness=1`, `roughness=0`, boosted `envMapIntensity`) whose shading is
   driven entirely by the environment map.
7. **Lighting** uses image-based lighting from a swappable HDR. The default is
   a procedural soft-box studio (`RoomEnvironment`), and clickable presets load
   real `.hdr` equirectangular maps (Venice Sunset, Sunrise, Urban, Quarry,
   Night, Mono Studio) via `RGBELoader` + `PMREMGenerator`. Each loaded HDR is
   cached so repeated switches are instant. Toggle "Show environment as
   background" to also bind the equirect texture to `scene.background`.
8. **Capture** (visible only in 3D mode): a floating shutter bar under the canvas
   takes either a still image or a video of the live scene. Images render the
   scene off-screen at the chosen resolution (720p–4K) and aspect ratio (Auto,
   1:1, 16:9, 9:16, 4:3); transparent exports auto-crop with a small margin.
   Videos are recorded directly from `canvas.captureStream(60)` via
   `MediaRecorder` (WebM), with optional auto-stop after 1/2/3 full rotation
   cycles when "Auto rotate" is on. WebM is downloaded as-is when the user picks
   the WebM format at native resolution; otherwise [`@ffmpeg/ffmpeg`](https://github.com/ffmpegwasm/ffmpeg.wasm)
   is **lazy-loaded** to remux/transcode to MP4, scale, or crop to a fixed
   aspect ratio. The wasm core (~30 MB) only downloads on first export.

## Running

```sh
pnpm install
pnpm dev
```

Then open <http://localhost:3000>.

## Files

- `app/page.js` — UI, main thread, Three.js scene, mesh build.
- `app/layout.js` — root layout.
- `app/globals.css` — styles.
- `app/mesh.mjs` — triangulation + balloon mesh assembly.
- `app/rendering.mjs` — material/HDR presets and PBR helpers.
- `app/capture.mjs` — image (`captureImage`) and video (`createVideoRecorder`)
  capture from the WebGL canvas, plus aspect/resolution/cycle math.
- `app/ffmpeg.mjs` — lazy `FFmpeg.wasm` wrapper for WebM→MP4 + crop/scale.
- `public/worker.js` — offset, raster, marching squares.

## Tests

```sh
pnpm test
```

runs `node --test` against the `app/*.test.mjs` files (mesh triangulation,
rendering presets, and capture helpers — all framework-free).

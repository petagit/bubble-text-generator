# Bubble Text Generator

Procedural bubble-text tool that takes any TTF/OTF font, inflates the glyph
silhouettes into balloon shapes, and renders them in 2D (SVG) or 3D
(Three.js, drag to rotate). All client-side — no build step.

## Pipeline

1. **Glyph paths** are extracted with [opentype.js](https://opentype.js.org/)
   and flattened to polygons.
2. A **Web Worker** does the heavy geometry off the main thread:
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
4. **3D output** triangulates each shape with **Delaunator** + a hex grid of
   interior Steiner points (clean, near-equilateral triangles — no slivers),
   then displaces front and back caps along Z by `(2t − t²) · thickness`
   where `t = distance / maxDistance` is the normalized inscribed distance.
   Boundary vertices are shared between the two caps so the silhouette
   shades smoothly.
5. Per-vertex Laplacian smoothing on the height field removes
   medial-axis ridges.

## Running

```sh
bash run.sh
```

Serves `index.html` at `http://localhost:8765/index.html`. A static server
is required because the file uses Web Workers and `OffscreenCanvas`, which
browsers block on `file://` URLs.

## Files

- `index.html` — UI, main thread, Three.js scene, mesh build.
- `worker.js` — offset, raster, marching squares.
- `run.sh` — local dev server.

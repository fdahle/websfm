# Plan: remaining professional interoperability formats

**Items 1–4 implemented 2026-08-07.** Items 5 (mesh texturing) and 6 (E57) stand
as written — see TODO ▸ "Remaining interoperability". What is still owed for the
shipped four is the external-application verification listed under each item;
none of it can run in a headless environment.

Follow-on to `plan-sfm-interoperability.md` (COLMAP workspace exchange, shipped
2026-08-06). That plan closed the **SfM-project** axis. This one closes the
**product** axis: the formats a surveying/GIS/web-delivery colleague expects to
receive from a photogrammetry package.

Scope: LAZ, tiled/COG rasters, undistorted image export, textured OBJ+MTL, E57,
Cesium 3D Tiles.

## Triage

The six candidates are not one workstream — they differ by an order of magnitude
in effort, and two of them are not export work at all.

| Item | Real blocker | Effort | Verdict |
| --- | --- | --- | --- |
| **Undistorted images** | none — the map already exists in `workers/ops/dense.js` | S | **Do first** |
| **COG / tiled GeoTIFF** | `writeCog` is uncompressed; needs the async deflate seam | S–M | **Do second** |
| **LAZ** | needs a WASM codec crate (`laz-rs`) | M | **Do third** |
| **3D Tiles** | trivial at 1 tile; LOD tiling is the real work | S (v1) / L (LOD) | **Ship v1, park LOD** |
| **Textured OBJ+MTL** | *there is no texture* — no UVs, no atlas, no bake | XL | **Reframe as a pipeline feature** |
| **E57** | XML + paged-CRC binary container in JS | M–L | **Decline for now** |

The ordering is deliberate: the first three each remove a named blocker from
`TODO.md` and none of them depends on the others, so they can ship in any order —
but they are listed by value-per-day.

---

## 1 — Undistorted image export  *(the cheapest real win)*

### Why it matters

This is the handoff to every external dense/mesh pipeline: OpenMVS, MVE, MVS-
Texturing and Meshroom all want **pinhole images + pinhole cameras**, which is
exactly COLMAP `image_undistorter`'s job. websfm is unusually well placed here
because the sparse model is *already* pinhole — distortion is folded out once at
ingest (CLAUDE.md, Pipelines §3). What is missing is only the matching **pixels**:
`image.url` still holds the raw distorted (or scan-space) raster.

### The load-bearing fact

Do **not** write a second distortion composition. The exact forward map already
exists and is already validated by the dense pipeline:

- `workers/ops/dense.js:55` `undistortRaster(r, Kfull, dist, selfCal)` — maps
  *undistorted pixel → distorted source pixel* and resamples. That is precisely
  an undistorted-image exporter.
- It composes the two bags correctly: calibrated `dist` **then** the self-cal
  `selfCalDistortion` bag (`core/sfm/displayFrame.js` `distortComposed`), and for
  a `kind:'film'` sensor it appends the canonical→scan affine
  (`core/sfm/fiducials.js` `canonicalToScan`, `dense.js:91-98`).

A second implementation would drift from dense, and the failure mode is silent:
an export that is subtly *not* in the sparse model's frame.

### Work

1. **Extract, don't copy.** Lift `undistortRaster` / `undistortMaskLut` and the
   film-scan branch out of `workers/ops/dense.js` into a pure
   `core/products/undistort.js`:
   `buildUndistortMap({ K, dist, selfCal, fiducial, width, height })` →
   `{ mapX, mapY }` (or a sampler closure), plus
   `resampleBilinear(src, map, spp)`. Dense imports it and keeps behaving
   identically — this is a refactor with an existing regression oracle (the
   ortho, which reuses the same frame).
2. **New worker op** `workers/ops/products.js` (or a small `undistort.js`):
   per image → `rasterize` the source (via `img.computeUrl ?? img.url` — never
   `url` alone, CLAUDE.md TIFF gotcha) → resample → encode PNG/JPEG →
   transfer home. One image at a time; never hold the batch in memory.
3. **Output shape** — match COLMAP's `image_undistorter` so downstream tools just
   work: `images/<name>`, `sparse/{cameras,images,points3D}.{txt|bin}` with every
   camera rewritten as `PINHOLE`, and (opt-in) `stereo/` omitted. Reuse
   `buildColmapModel` from `core/io/colmapModel.js`; the model needs **no**
   distortion edit, only a model-name change, because it is already pinhole.
4. **Delivery**: a directory via `showDirectoryPicker()` when available, else a
   streamed zip. A 200-image undistorted set blows the 4 GB plain-ZIP ceiling
   (`core/io/projectArchive.js` `archiveSizeVerdict`) — reuse that pre-flight and
   its message rather than inventing a second one.
5. **Options**: `mode: 'crop' | 'full'` (COLMAP's `blank_pixels`/roi behaviour —
   crop to the largest valid rectangle, or keep the full frame with black
   borders), output format + quality, and "also write masks" (the mask LUT path
   is already in the extracted module).

### Verification

- Unit: a synthetic k1 lens — undistort then re-distort a grid, error < 0.1 px.
- Unit: a film sensor — the exported image's fiducial marks land on the canonical
  frame's calibrated mm positions.
- Cross-check: run the exported workspace through COLMAP `point_triangulator`;
  reprojection RMS must match websfm's own report within tolerance.
- Manual: open in OpenMVS `InterfaceCOLMAP`.

---

## 2 — Tiled / Cloud-Optimized GeoTIFF export

### Current state

Two writers exist in `core/products/geotiff.js` and they split by *purpose*, not
by capability:

- `writeGeoTiff` — baseline single-strip, DEFLATE via an **injected async**
  callback. This is the export path.
- `writeCog:210` — internally tiled + halving overviews, but **uncompressed**,
  because per-tile DEFLATE would need that async callback per tile per level.
  Today it only serves imported reference rasters.

So the missing piece is not "tiling" — it is the seam that lets the tiled writer
compress.

### Work

1. **Make the compressor an async seam in `writeCog`.** Two options; take (b):
   - (a) make `writeCog` async and `await deflate(tile)` per tile — simple, but
     serializes thousands of round-trips through `CompressionStream`.
   - (b) **split layout from bytes**: `planCog(spec)` (pure, sync) returns the
     tile list + the IFD skeleton with placeholder offsets; the caller compresses
     tiles (batched, or in parallel), then `assembleCog(plan, compressedTiles)`
     patches `TileOffsets`/`TileByteCounts` and emits. Keeps the pure core pure —
     the same reason the deflate callback was injected in the first place — and
     lets a worker compress N tiles per await.
2. **COG-correct ordering**: full-resolution IFD first, then overviews in
   decreasing resolution, each tiled; keep the existing single-tile-level
   inline-value rule (count·size ≤ 4 ⇒ the field *is* the value — already
   handled, don't regress it). Add the GDAL ghost-area header so `gdalinfo`
   reports `LAYOUT=COG`.
3. **Wire it as an export format**, not a replacement: `DemModal`/`OrthoModal`
   gain `geotiff-cog` alongside `geotiff`. Baseline stays the default for small
   outputs; recommend COG above a size threshold (a derived recommendation, so
   it follows the `useDatasetRecommendations` rule — surfaced on the control, not
   as a banner).
4. **Also fixes an existing asymmetry**: imported reference rasters currently
   round-trip uncompressed. Once (1) lands, `useExternalStore`'s import path can
   compress too — a large REMA tile stops costing its full uncompressed size in
   OPFS.

### Verification

- `gdalinfo -json` on the output: `LAYOUT=COG`, `BLOCKSIZE=512x512`, overview
  count and sizes as planned.
- Byte-identical pixel round-trip through `geotiff.js`'s own reader for float32
  DEM (nodata preserved) and uint8 RGB ortho.
- A partial HTTP range read of the overview IFD returns a valid preview — that is
  the whole point of the format.

---

## 3 — LAZ

### Why a crate

There is no credible pure-JS LAZ *writer*. The right answer follows the precedent
already set twice in this repo (`crates/mesh`, `crates/imagecodec`): a new
dependency-carrying crate, isolated so it never leaks into
`crates/reconstruction`.

- **`laz`** (Apache-2.0; the repo is laz-rs) — pure Rust LASzip implementation,
  read **and** write, compiles to `wasm32-unknown-unknown` without threads.
  Shipped at 0.12.2.
- New crate `crates/lazcodec`, wasm-bindgen surface:
  `compress_points(header_bytes, point_bytes, format, count) -> Vec<u8>` and
  `decompress_points(...)`. Keep the LAS *header/VLR* logic in JS
  (`core/io/las.js` already owns it) — the crate only does the chunked
  arithmetic coding.

### Work

1. Scaffold `crates/lazcodec`; add to `npm run build:wasm`; commit `src/wasm/*`
   with the source change (CLAUDE.md rule).
2. **Add the `THIRD_PARTY` entry in `src/core/help/licenses.js`** — `laz`
   Apache-2.0, real SPDX id + upstream URL (done, with byteorder + num-traits). There is no build-time scanner; a
   missing entry is an incomplete legal notice.
3. `core/io/laz.js` — pure chunk framing + the LASzip VLR (record id 22204),
   compressor injected the same way `geotiff.js` injects `deflate`, so the pure
   module stays testable without wasm.
4. **Streaming is mandatory.** `prepareCloudForExport` already streams the dense
   accumulator with no per-point objects; LAZ must keep that property —
   compress per chunk (50 k points) and append, never build one giant point
   buffer. A 30 M-point fused cloud is the design case.
5. **Import falls out**: `las.js` currently rejects LAZ explicitly. Wire
   `decompress_points` into `parseLas` and drop the rejection — remember the
   header-authoritative stride rule (`pointDataRecordLength`, never inferred from
   the format id).
6. Expose in `ExportModal` `cloud.formats` as `LAZ (compressed LAS)`; the LAS
   options (georef, downsample cell) are unchanged.

### Verification

- Round-trip in-repo: write LAZ → decompress → byte-identical to the LAS the
  same cloud produces.
- `laszip -i out.laz -o check.las` and `lasinfo` externally; open in CloudCompare
  and QGIS.
- Point formats 2 (what we write) and 3/6–8 on read.
- Size check: expect 5–10× over LAS; log it (a derived number gets a log line).

---

## 4 — Cesium 3D Tiles

Split this honestly, because "3D Tiles support" hides a 20× effort range.

**v1 — single-tile tileset (a day).** `tileset.json` + one `.glb`, using the
existing `meshToGlb`. Georeferencing is the only real content: the tile
`transform` is an ECEF placement matrix, so the project CRS → EPSG:4978 path goes
through the existing proj4 setup — polar projects are exactly where a naive
"assume WGS84 UTM" shortcut breaks, so derive it, don't assume it. Ships 3D
Tiles **1.1** (glTF content, no `b3dm`/`pnts` legacy containers). Point clouds
get the same treatment: a `.glb` with `POSITION` + `COLOR_0`.

**v2 — LOD tiling (weeks; park it).** A quadtree split with per-tile decimation
is what makes 3D Tiles worth using on a real dense cloud, and it needs a
simplification pass websfm does not have. Do not start v2 until someone actually
streams a websfm product into Cesium and hits the limit — v1 already covers
"show my model on a globe".

---

## 5 — Textured OBJ+MTL — reframe

**The OBJ+MTL writer is not the problem.** `meshToObj:204` writes per-vertex
colour today; adding `usemtl` + a `.mtl` file + `vt` lines is an afternoon. The
blocker is that **there is no texture to reference**: the mesh has no UV
parameterization and there is no bake step. `crates/mesh` produces
positions/indices/colours transferred from the nearest dense voxel — vertex
colour, capped at mesh resolution.

So this is a **pipeline feature ("Texture Mesh"), not an export format**, and it
is the largest item on this page. Its shape:

1. **UV atlas** — xatlas is the standard answer (C++, MIT); a `crates/atlas`
   WASM wrapper, or the pure-Rust `uv-atlas`/`xatlas-rs` bindings. Isolated crate,
   licenses entry, same precedent.
2. **View selection + bake** — per chart, choose source images by visibility
   (reuse the depth maps as the z-buffer, exactly as `core/products/ortho.js`
   already does) and angle-to-normal; blend seams (MVS-Texturing's approach:
   per-face labelling + Poisson seam levelling).
3. **Outputs** — then OBJ+MTL+PNG, and glTF/GLB with a `baseColorTexture`,
   both nearly free once (1) and (2) exist. It also upgrades the 3D Tiles v1
   output for free.

Recommendation: **keep it in TODO under Products, not under interoperability**,
and let items 1–3 ship first. If a textured deliverable is needed sooner, the
honest interim is the existing OBJ with vertex colours plus the orthophoto — most
GIS consumers of a DEM+ortho pair need no texture at all.

## 6 — E57 — decline, with reasons

E57 (ASTM E2807) is the surveying interchange standard, so the instinct is right.
But: the container is an XML header over paged binary sections with a **CRC-32
per 1024-byte page** and per-field bitpacked `CompressedVector` encoding. That is
a genuine multi-week JS/WASM implementation, and there is no maintained
browser-targetable library.

Against that cost, the overlap is near-total: **LAZ (item 3) reaches the same
audience** — CloudCompare, QGIS, ArcGIS, Cyclone and Faro all read LAZ. E57's
distinctive value is structured multi-scan data with per-scan poses and embedded
panoramic imagery, which is a **terrestrial laser scanning** concern, not an
aerial-photogrammetry one.

Revisit only on a concrete request naming the receiving software. If it comes,
the cheap first step is **read** support (import a client's E57 as a reference
cloud), not write.

---

## Sequencing

```
1. Undistorted images   ── unblocks OpenMVS/MVE/MVS-Texturing handoff
2. COG export           ── unblocks large-raster delivery + compresses imports
3. LAZ                  ── unblocks survey delivery + LAZ import for free
4. 3D Tiles v1          ── a day, once GLB georeferencing is settled
────────────────────── ship, then reassess ──────────────────────
5. Mesh texturing (Products, not interop) — only if wanted
6. E57 — only on demand, read-first
```

Items 1–4 are independent; 1 and 2 touch disjoint files and can run in parallel.

## Cross-cutting rules (from CLAUDE.md — do not rediscover)

- Pure format logic goes in `core/io/` or `core/products/`; **no** Vue/OPFS/DOM.
  Compressors and codecs are **injected callbacks**, like `geotiff.js`'s
  `deflate` — that is what keeps the pure path testable in the node test env.
- Every new crate: `npm run build:wasm`, commit `src/wasm/*` with the source,
  add the `THIRD_PARTY` entry in `core/help/licenses.js`.
- New export options belong in `EXPORT_DEFAULTS` (`core/defaults.user.js`) — one
  home, no hardcoding the same knob in both the modal and core.
- Long exports (undistortion, LAZ of a 30 M-point cloud, COG of a large ortho)
  run in a worker and report a **monotonic 0..1 fraction**, not a work counter.
- Never materialize a per-point object list, and never spread a typed array into
  a variadic call.
- `npm test` + `npm run typecheck` per change. The tests are node-only over
  `src/core/**`, `src/utils/**`, `src/stores/**` — a test placed under
  `workers/` silently never runs. Anything touching a file picker, OPFS or a
  real external application needs a **manual browser pass**, which this
  environment cannot perform; record it as owed in HANDOVER, as the F1 export
  phases already do.

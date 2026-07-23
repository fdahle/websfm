# Plan — reference rasters: raw storage, COG, draw-time styling

> **Supersedes §A of `plan-external-reference-data.md`** (storage + display).
> That file's §B taxonomy shipped and is unaffected.
>
> **No back-compat.** Hard development phase: nothing imported under the old
> design must survive. The index schema, the sidecar layout and the store API all
> change freely; existing projects are expected to re-import. There is
> deliberately **no migration path and no legacy read path** — every "or the old
> shape" branch we skip is a branch that can't rot.

Goal: an imported reference DEM / orthophoto is stored as **raw values**, styled
**at draw time** like QGIS, drawn on the 2D map, and readable at full resolution
by the sampler and (later) by automatic GCP matching against satellite imagery.

---

## Why the current design has to go, not be tuned

Today an imported raster is decoded once at import and stored as a **baked plane**:
Float32 elevations for a DEM, 8-bit RGBA for an ortho. Three consequences, and
they are structural rather than incidental:

1. **Styling is a re-decode of the original file.** The bake is already-rendered
   pixels; the reflectance numbers band math needs (1255…14300 on the benchmark
   Sentinel-2 scene) are gone from it. Every restyle re-reads the source: ~10 s
   for a 5000×5000×6 int16 file, plus a 100 MB OPFS write.
2. **The ortho bake has no reader.** `readWindow` has no consumers outside its
   own definition, and `sampleAt` returns null for orthos by construction
   (`buildSource` passes a null value plane). The 100 MB exists to be
   downsampled into a 1024 px PNG.
3. **Raw values are unrecoverable**, which blocks the two things that matter
   next: sampling ortho pixels for automatic GCP finding, and honest band math.

A cache whose only reader is a thumbnail generator, and which destroys the data
its main future consumer needs, is not worth making fast.

---

## The two findings this plan is built on

**OpenLayers 10.9 already does QGIS-style raster rendering.** `ol/source/GeoTIFF`
accepts a **Blob** (`node_modules/ol/source/GeoTIFF.d.ts:19`) — which is what
OPFS hands back — and `ol/layer/WebGLTile` applies band selection, contrast
stretch, normalised-difference math and colour ramps as a **GPU style expression
at draw time**. That is QGIS's model. It deletes the bake → PNG → `ImageStatic`
pipeline rather than optimising it, and makes restyling a uniform update:
instant, no decode, no write.

**COG is therefore load-bearing, not an optimisation.** That OL source reads
reduced-resolution IFDs when they exist and decodes full resolution when they
don't. Feed it a striped 5000²×6-band TIFF and every pan re-decodes ~300 MB.
Overviews are what make the renderer usable at all.

> **COPC is not this.** COPC is cloud-optimized *LAZ* — the point-cloud
> equivalent, relevant to imported PLY/LAS clouds and worth its own plan. The
> raster format is COG.

---

## Target design

**The original file is the source of truth. Derived artifacts are a cache, with
exactly one justified exception.**

| Artifact | Written when | Read by | Why it exists |
|---|---|---|---|
| `external/{id}.cog` | background job at import | map renderer, sampler, matching | tiled + pyramided; the single artifact serving all three |
| `external/{id}.src` | import | the conversion job only | source of truth; re-convertible, never deleted |
| `external/{id}.dem.f32` | conversion, DEMs only | `sampleReferenceDem` | random-access point sampling wants a flat array, not a tile decode per GCP |
| thumbnail in `index.json` | import (immediate) | sidebar rows, list views | must render with nothing decoded and no GPU |

Gone: the ortho RGBA bake, `previewDataUrl` as a *map* input (it survives only as
a list thumbnail), and the entire notion of a "styled plane on disk".

**Style becomes pure view state.** It is a small plain object in `index.json`
that the renderer reads as a GPU expression. Changing it touches no pixels on
disk, so `styleStamp` / `planeStyleStamp` / `redecodePlane` / the preview-restyle
worker op all cease to have a reason to exist.

### Why a real COG and not a private sidecar pyramid

A private tiled format would be simpler to write, but it would have to be read by
code we also write — and `ol/source/GeoTIFF` needs an actual TIFF. Writing COG
means one artifact feeds the map renderer, the windowed sampler, matching, and
export, instead of a private format plus a separate export path. The cost is a
tiled multi-IFD TIFF writer; `core/products/geotiff.js` is currently explicitly
"baseline, uncompressed, **single strip**", so this is a genuine extension, but
it is pure, sync, and fully testable without a browser.

---

## Phases

### Phase 0 — Spikes (do first; they can invalidate 2–5)

Cheap experiments whose failure changes the plan. Do not start Phase 1 until
these answer.

- **0a. Polar projection under WebGL.** Render a EPSG:3031 GeoTIFF via
  `ol/source/GeoTIFF` + `WebGLTileLayer` on the existing map. This is *the*
  assumption everything downstream rests on: the current design leans on OL
  reprojecting an `ImageStatic` on the fly, and the WebGL tile path has different
  reprojection constraints. **If this fails, phases 3–5 change shape** — fallback
  is `ol/source/DataTile` with a CPU compose, keeping draw-time styling but
  losing the GPU.
- **0b. Blob source from OPFS.** Confirm an OPFS `File` drives the source
  directly, including range reads (the point of COG) rather than a full slurp.
- **0c. Style expression coverage.** Confirm the OL style expression language
  covers: per-band selection, per-channel min/max stretch, gamma, normalised
  difference, and a colour ramp. Anything it can't express is a constraint on the
  Phase 4 UI, and better known now.
- **0d. Measure.** The benchmark 5000×5000×6 int16 scene, as-is vs converted:
  import time, first paint, pan/zoom latency, restyle latency, disk. **Every
  timing claim in this plan is currently an estimate** — this is what replaces
  them with numbers, and what decides whether conversion is default-on.

### Phase 1 — COG writer (`core/products/geotiff.js`) — ✅ **DONE 2026-07-20**

> Shipped ahead of Phase 0 deliberately: it survives either branch of spike 0a
> (a `DataTile` CPU-compose fallback still wants tiled, pyramided data), and it
> is the one phase verifiable without a browser. Deviations from the sketch
> below: `writeCog` takes a **TypedArray** rather than raw bytes (it must
> interpret pixels to tile and downsample), and stays **uncompressed** —
> per-tile DEFLATE means the injected async callback per tile per level, which
> the "compression" open question says to measure before adding.


Extend the existing writer with **internal tiling** and **multiple
reduced-resolution IFDs**, plus the COG layout rules (IFD ordering, offsets
ascending, overviews after full-res). Pure and sync; the deflate callback
injection pattern already there is unchanged.

Tests: round-trip through `geotiff.js`'s reader — tile boundaries, non-multiple
dimensions, each dtype we accept (int16 / uint16 / float32), and an
overview-selection assertion (`tiff.readRasters({width})` must pick a reduced IFD,
not the full-res one).

Deliverable: `writeCog(spec)` alongside `writeGeoTiff(spec)`. No store, no UI.

### Phase 2 — Import: fast-first, convert in background

Split the import into "record now" and "prepare later":

1. **Immediate (~1 s)**: read header, geotransform, CRS, band/dtype metadata,
   classify DEM-vs-ortho, and decode a small thumbnail. The record appears in the
   sidebar straight away with a `prepare: 'pending'` state.
2. **Background job**: convert to COG (+ write the DEM float32 plane), reporting
   progress to the sidebar row. A source that **already has overviews** skips
   conversion and is used directly — detectable from the IFD count.
3. **Consumers never block on it.** Sampling and matching either await the job or
   fall back to decoding from the original, so a pending raster is usable, just
   slower.

The queue is one job at a time (conversion is memory-hungry; two 300 MB decodes
in parallel is the OOM the dense budget exists to prevent). Cancellable, and a
failed conversion leaves the raster usable-but-unprepared rather than broken.

### Phase 3 — Map rendering

Replace the raster `LayerGroup` in `ViewerMap.vue` (currently
`ImageStatic`-of-a-PNG per raster) with one `WebGLTileLayer` per raster over an
`ol/source/GeoTIFF`, styled from the raster's style record. `onMap` / `opacity` /
list-order-is-draw-order all keep their current semantics.

This is where two of the reported bugs stop existing as concepts: the "reload the
view to see it" repaint bug (no baked image to swap) and the seconds-long apply
(no decode). The `previewUrl` layer-rebuild fix added on 2026-07-20 is deleted
here — it was correct for the architecture it patched.

### Phase 4 — Styling UI

Only now does the modal work pay off, because the preview is the live map.

- Rebuild `RasterStyleModal.vue` on the shared modal framework (`ModalShell` +
  `SettingsField`/`SettingsGroup`/`SegmentedControl`/`AdvancedDisclosure`). It is
  currently 268 hand-rolled lines predating that framework.
- **Delete Apply and the "Will apply" bar.** Both existed because a preview cost
  a full re-decode; the footer becomes Reset / Close.
- **Colour ramps for single-band, DEMs included.** Today "Greyscale" is the only
  single-band mode while DEMs get a hardcoded hillshade+ramp in the worker —
  two disagreeing colour paths, neither reachable from the other, which is why
  the modal says grey while the map shows colour. Hillshade becomes one option
  among ramps, and the `styleable: kind !== 'dem'` exclusion is dropped: a DEM
  gets a ramp and a z-range stretch like any other single-band raster.
- **Index becomes a band, not a display mode.** Put it in the band picker
  (`Band 1…N`, `NDVI (B8, B4)…`, `Custom index…`) so the model is "pick what to
  show" → "pick how to colour it". Three modes collapse to two, the ramp control
  applies uniformly, and the index's fixed −1…1 scale becomes a property of the
  derived band rather than a special case in the renderer.

### Phase 5 — Sampling + windowed reads

- Real tiled `readWindow` on `RasterSource`, backed by the COG. Its first honest
  consumer.
- Keep the flat Float32 fast path for DEM point sampling — `sampleReferenceDem` is
  called per GCP, and a tile decode per point would be absurd.
- `rasterSample.js` stays THE sampler; this changes where bytes come from, not the
  half-pixel/nodata convention.

Groundwork only. **Automatic GCP finding from satellite imagery is its own
plan** — it needs feature detection over a reference window, matching against
project images, and a pixel→world→CRS path to a surveyed coordinate. What it
needs from *this* plan is exactly what Phase 5 delivers: raw, full-resolution,
windowed access.

### Phase 6 — Setting

One knob, in Settings ▸ (Compute or a new Reference Data group):

> **Prepare imported rasters for fast access** — converts to a tiled, pyramided
> copy on import. Faster panning, styling and sampling; roughly doubles disk use
> per raster.

Default decided by 0d's measurements. Show the actual figure per raster in the
sidebar so the tradeoff is concrete rather than abstract.

Explicitly **not** settings: tile size, overview levels, compression,
resampling — `tuning.js` material. "Store as COG?" is a question about
implementation that a user cannot evaluate, and exposing it invites a wrong
answer.

---

## What gets deleted

Not left in place, not deprecated — removed, since nothing old is supported:

- the ortho RGBA bake and its OPFS sidecar
- `styleStamp` / `planeStyleStamp` / `redecodePlane` / the `restyleRasterPreview`
  worker op + client wrapper (all 2026-07-20; they manage a plane this design
  does not have)
- the `previewUrl` layer-rebuild fix in `ViewerMap.vue` (same date, same reason)
- `parseRaster`'s ortho compose path, `needsStyling`'s role as a *storage* gate
  (the band math moves to the GPU; `rasterStyle.js` keeps the pure range/index
  math the style expression is built from)
- `styleable` on the meta — every raster is styleable now

## Open questions

- **Does the DEM float32 plane survive Phase 5, or does a COG tile cache make it
  redundant?** Decide with 0d numbers, not in advance.
- **Compression for the written COG.** DEFLATE needs the injected-callback dance
  (`CompressionStream` is DOM/worker-only, the pure path can't compress).
  Uncompressed is simpler and OPFS is local — measure before adding it.
- **Nodata through a GPU style expression.** The current compose makes a pixel
  transparent if *any* input band is nodata, so a stack's collar never renders as
  spurious colour. Confirm in 0c that the expression language can express this;
  it is a correctness requirement, not a nicety.

## Verification

Phases 1 and 4's pure parts are `npm test` + `npm run typecheck`. **Phases 0, 2,
3 and 5 are browser-runtime work** — WebGL rendering, OPFS, background jobs — and
cannot be verified in the agent environment. Say so explicitly rather than
claiming verification; the previous plan's §A shipped unverified and that is how
the repaint bug survived.

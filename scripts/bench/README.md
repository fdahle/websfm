# Headless pipeline bench

Runs the real app pipeline: ingest, then SIFT detection, then matching, then sparse
SfM. It runs on a folder of images in headless Chrome, with no clicking. It drives the
same Pinia stores, worker pool, WebGPU matcher and OPFS persistence as the UI. Each run
gets a fresh on-disk browser profile, deleted afterwards, so it starts from an empty OPFS.
The profile is on disk because an incognito context keeps OPFS and blobs in memory, and
a multi-GB dataset exhausts that.

To try it without a dataset of your own, fetch the example (`npm run fetch:examples`)
and run the one committed config, which takes it from detection to the orthophoto:

```sh
node scripts/bench/run-bench.mjs --config scripts/bench/example-aukerman.json
```

```sh
node scripts/bench/run-bench.mjs --config scripts/bench/configs/sb-default.json
node scripts/bench/run-bench.mjs --images C:/data/set --limit 20 --detect '{"maxDim":3200}'
```

Each run writes to `bench-out/` (gitignored):

| file | contents |
|---|---|
| `<name>-<time>.log` | every log line, debug included, in the dev console's export format |
| `<name>-<time>.json` | resolved settings and per-stage numbers: keypoints, pairs, accepted, inliers, cameras, points ≥3 views, seconds, and `positionCheck` (below) |
| `<name>-<time>.build/` | the frozen app build the run used |

## Config

A JSON file (`--config`), and/or flags with the same names. Flags win.
Configs live in `scripts/bench/configs/`, which is gitignored: they name datasets by
local path. An example, with RTK camera positions and GCP checkpoints from a Metashape
project:

```json
{
  "name": "puti-gcps",
  "images": "C:/data/aerial_images_with_gcps/Images",
  "sceneType": "aerial",
  "reference": {
    "cameras": "C:/data/aerial_images_with_gcps/Metadata/Cameras_WGS84.txt",
    "sigmaColumns": [8, 9, 10],
    "gcps": "C:/data/aerial_images_with_gcps/Metadata/GCPs_WGS84.txt",
    "leverArm": "C:/data/aerial_images_with_gcps/Metadata/GNSS_offset.txt",
    "metashape": "C:/data/aerial_images_with_gcps/Metashape/Project_aerial_GCPs.files",
    "importPoses": true
  },
  "match": { "strategy": "preselect", "preselectMethod": "position", "maxNeighbors": 20 },
  "variants": [
    { "label": "noPriors", "recon": { "posePriors": false } },
    { "label": "priors" }
  ]
}
```

`reference` fields: see `reference.mjs`. `importPoses` imports the camera file as poses
(with its standard deviations), which preselection needs. The run then reports
`checkpointCheck` per GCP as well as `positionCheck`.


- `images`: the dataset folder. `include` is a filename regex. `limit` keeps the first
  N files after sorting.
- `video`: one video file instead of `images`. Its frames are planned and extracted as
  **Import ▸ Video** does, with `videoImport` (the dialog's settings, over
  `VIDEO_IMPORT_DEFAULTS`: `mode`, `every`/`unit`, `overlap`, `maxFrames`,
  `minSharpness`, `format`, `jpegQuality`, `maxDim`). The `ingest` stage then reports
  the video's size, length and frame rate, the scan (samples, travel, blurry samples,
  gaps) and the frames extracted. Use H.264, VP9 or AV1: the bench runs Chrome.
  Pair it with `"match": { "strategy": "sequential" }`, the dialog's start for frames.
- `sceneType`: `object` or `aerial`.
- `detect`, `match`, `recon`: settings layered over the app's defaults, exactly as the
  modals do it. `preset` selects a preset delta (`low` / `high`).
- `stages`: default `detect,match,recon`. Also `depth` and `dense` (settings as the
  Depth Maps / Dense modals resolve them; config keys `depth`, `dense`), `dem` and
  `ortho` (as the DEM / Orthophoto modals resolve them; keys `dem`, `ortho`). The ortho
  stage reports the ortho's quality figures (`stats`: sharpness in grey levels per cell,
  and the seam step between source images vs the step inside one image) and writes the
  ortho as `<out>.ortho.png` for side-by-sides. And `reopen`:
  reload the page (OPFS survives in the on-disk profile) and restore the project through
  the app's own open sequence, timed per store. After every stage an `== inventory` line
  prints what the page holds per item (keypoints, match tuples, clouds, depth maps) and
  its memory: the **V8 heap** and the ArrayBuffers apart (DevTools `Runtime.getHeapUsage`),
  plus `performance.memory`, which counts both together.
- `gcpz`: GCP ▸ Fill Z (overwrite) and Check Z against the imported reference DEM
  (after an `importraster:<tag>` stage); the summary gives the fill counts and Check Z's
  mean / RMS / median / max |Δ|.
- `procTrace: <seconds>` (Linux): the resident memory (VmRSS) of the bench's Chrome
  renderer processes every so often, and its peak (`procPeakGB` in the summary). Unlike
  `memTrace` it counts WebAssembly memory, where fusion keeps its accumulators.
- `profileReopen: true`: a CPU profile of the `reopen` restore, saved as
  `<out>.reopen.cpuprofile` (load it in DevTools) with its top self-time functions on the
  console.
- Learned detectors: `detect: { "detector": "superpoint" }` (or `disk`) starts from that
  detector's defaults, as the modal does; `match: { "matcher": "lightglue" }` picks the
  LightGlue for it. The page puts the weights into Cache Storage itself (the consent
  dialog cannot be clicked headless), so the `.onnx` files must be in `public/models/`.
  SuperPoint's are not redistributable: copy your own `superpoint.onnx` there, and
  remove it before a release build (`check-release` refuses a build that contains it).
- `variants`: `[{ label, match?, recon? }]`. Detection runs once; each variant then
  re-matches only when its match settings change, and always reconstructs. Use this
  for SfM-only experiments on identical inputs.
- `dev`: use the Vite dev server instead of a frozen build (faster to start). Any
  source edit then reloads the page mid-run.
- `build <dir>`: reuse an earlier snapshot. `headed`: show the browser window.
- `recon.baSolver`: the bundle-adjustment linear-solver policy (`SFM_TUNING.baSolver`,
  merged key by key, so a variant names only what it changes), e.g. `{ "pcgMinN": 1e9 }`
  (Cholesky only), `{}` (the default: inexact PCG, 200 iterations, partial accepted),
  `{ "pcgRelTol": 1e-10, "pcgMaxIter": 2000, "pcgAcceptPartial": false }` (the exact solve)
  and `{ "pcgPreconditioner": "ic0" }` (block incomplete Cholesky).
  The result JSON carries `baSolver` (solves, CG iterations, fallbacks, BA seconds)
  and `timings`.
- `recon.posePriors: false`: disable every camera pose for that run. That includes the
  EXIF GNSS positions the app imports automatically, which otherwise constrain bundle
  adjustment as camera priors.

## Accuracy: `positionCheck`

When the images carry EXIF GNSS, each reconstruction is compared with it
(`core/eval/positionCheck.js`). The check fits the best 7-parameter similarity from the
SfM camera centres to the positions and reports the residuals in metres: RMS 3D, plus
horizontal and vertical median, p95 and max, and the five worst images. With RTK/PPK
positions this measures the model's **shape** error (doming, bending, scale drift), so a
change can be judged as more correct rather than merely larger. Run it with
`posePriors: false`. Otherwise bundle adjustment has already been pulled towards the same
positions, and the check is no longer independent.

## Accuracy: LiDAR surface (`lidarCheck`)

With `reference.lidar` (`dir`, `crs`, `cell`, `flatRangeM`; see `lidar.mjs`), the strips
are decoded once and binned into a height grid, cached under `bench-out/cache/`. Each
reconstruction then exports its ≥3-view points in the `positionCheck` ENU frame, and the
runner maps them to the LiDAR CRS. Only cells whose LiDAR heights span ≤ `flatRangeM`
count, because on slopes, edges and vegetation the two sensors legitimately differ.

The camera GPS that defines the frame may be metres off, and ellipsoidal where the
LiDAR uses a national height datum. The check therefore fits a horizontal shift and a
vertical offset first, and reports only the shape that remains: `rmsM`, `medianAbsM`,
`p90AbsM`, `within10cm`, the block tilt (`tiltPer100m`) and the dome (`domeAtEdgeM`,
the quadratic term at the 95 % radius; positive means a bowl). The `dome*` fields
(`domeRmsM`, `domeWithin10cm`, …) are the same after the dome is removed as well.

After a `dense` stage the fused cloud is scored the same way (a ≤1 M-point stride
sample), under `stages.dense.lidarCheck`. Two fusions of one model share its dome, so
compare them on the `dome*` fields. A stage may carry a tag to repeat it with other
settings on the same inputs: `"stages": "…,depth,dense,dense:loose"` runs the dense
stage again with config key `dense:loose`.

## More config keys

- `recursive: true`: walk sub-folders (a MicaSense SET splits captures into 000/001/…).
  The image name is the basename.
- `minGpsAlt`: drop images whose EXIF GPS altitude is below this, for example ground
  captures before takeoff.
- A variant's `recon.leverArm: true` sets `reference.leverArm` on every sensor
  (`gnssLeverArm`), so camera priors are treated as antenna positions. Without it the
  arm is used only to evaluate camera positions.
- `sensor: { focal, focalUnit, cx, cy, k1 … k6, p1, p2, distortionModel }` (top level)
  merges every sensor into one with that calibration right after ingest, before
  detection, so matching already sees it (a fisheye block needs this: its matches are
  verified in the pinhole frame).
- A variant's `recon.sensor: { focal, focalUnit, cx, cy, k1 … k6, p1, p2,
  distortionModel }` pins every sensor's calibration for that run, in sensor-table
  conventions: absolute pixel-centre `cx`/`cy` (Metashape's are offsets from the centre
  in pixel-edge coordinates: `W/2 + cx − ½`) and OpenCV `p1`/`p2` (Metashape's are
  swapped). A calibrated Brown model turns `'auto'` self-calibration off. A variant
  without it gets the EXIF-grouped sensor back.
- Worker heap: every recon stage prints `== worker heap <stage> ▸ <segment>` with the
  SfM worker's peak V8 heap (the ~4 GB per-isolate ceiling) and heap + ArrayBuffers
  (typed arrays and wasm memory, outside that ceiling), per segment of the solve. The
  segments close on the solver's `stage "…" took` and `memory mark "…"` debug lines;
  the numbers land in the result JSON as `workerHeap` (`workerHeap.mjs`, Chrome DevTools
  Protocol, sampled every 250 ms, so a shorter spike can be missed).
- `maxOldSpaceMb`: raise V8's heap ceiling for the page and its workers
  (`--max-old-space-size`), so a run that would die at ~4 GB finishes and reports its
  real peak. Users cannot do this; use it only to measure.
- `dumpSfmInput: true`: save each recon's exact SfM worker payload as
  `<out>.<stage>.sfminput` (`tests/bench/sfmInputDump.js`). Node replays it bit for bit
  as a real-data golden scene (`WEBSFM_SFM_GOLDEN_INPUTS`, `src/core/sfm/sfmGolden.test.js`).
- `export:<tag>` stages run one export through the app's dialog dispatch, with config
  key `export:<tag>` = `{ kind, settings, cloud? }`. Each download is saved as
  `<out>.<tag>.<file>`. Besides the dialog kinds (`cloud`, `mesh`, `colmap`, `dem`,
  `ortho`, …), `keypoints` and `matches` produce the sidebar's JSON downloads, so two
  tags around a `reopen` can be compared with `cmp`.
- `togglepair`: exclude one accepted pair, then include it again, as the match list
  does. Reports the project's `matches/` files after each save; a toggle should only
  replace the `flags.bin`.
- An export spec may name the cloud: `{ kind, cloud, cloudName }` exports the cloud of
  that kind with that exact name (a derived or edited copy) instead of the computed one.
  For `kind: "tiles3d"` it selects that cloud or mesh first (3D Tiles writes the selection).
- `reseau[:tag]`: Tools ▸ Images ▾ ▸ Detect reseau on the block's sensor (settings from
  `cfg.reseau`, film size from the scans) and applies the 'reseau' calibration; with
  `reseauTruth: <truth.json>` (a `synth_sat.py --reseau-mm … --film-warp-um …` block) each
  image's fit is scored against the film truth in scan pixels (SAT-5: < 0.5 px).
- `reseauhalves`: Detect reseau ▸ Half frames: every `<frame>_a` / `_b` pair stitched
  into one frame through its reseau, GCP marks carried over, the halves removed; with
  `reseauTruth` each half's fit is scored as for `reseau`. Run `detect` etc. after it.
- `sensor`: applies the config's calibration again (`hist.intrinsics`, else `sensor`),
  e.g. after `reopen` on a project saved before the bench persisted it (2026-10-19).
- `georef`: Georeferencing ▸ Georeference, from GCPs or the camera positions, into the
  project CRS (top-level `crs`). Then `dem: { "crs": "project" }` builds in that CRS.
- `meshtools`: TOOL-03 on the computed mesh: Clean → Decimate 25 % → Smooth 10 → Clean
  with every hole closed → Area & volume. Each step is a named copy (`TOOL03 cleaned`,
  `… decimated`, `… smoothed`, `… closed`) for `cloudName` exports.
- `importraster:<tag>`: Import ▸ Reference raster of `cfg[tag].path`, then the
  background display conversion. `rastersample:<tag>` samples the last reference DEM at
  `points` given in the project CRS (reports the raster-CRS point, z, and whether its
  plane was resident); `rasterstyle[:tag]` restyles the last raster with a new stretch.
- `aligncheck`: moves the computed dense cloud by a known transform, puts it back by
  3 point pairs (with pick offsets) and ICP onto the imported dense reference, then
  Distance to reference; reports the residual left per point.
- `pool:<n>`: set the compute worker pool to n workers (Settings ▸ worker count; 0 =
  the default). It applies at once only while the pool is idle (`ok`); it is also
  stored, so `pool:1,reopen,depth:one,dense:one` repeats a run on one worker.
- `stallMinutes` (default 30): abort the run when no log line arrives for this long,
  or at once if the page crashes. A worker that dies of memory otherwise leaves the
  bench waiting forever. Each stage also logs the renderer heap before/after a GC.
- `reference.markOffsetsPx: [-0.5, 0.5]` re-scores the checkpoints at shifted mark
  conventions on the same model; `reference.excludeGcps` keeps known-bad GCPs out of
  the RMS (they are still listed). `reference.gcpOverrides: { "19": [lat, lon, h] }`
  replaces one GCP file line (GeoScan's 19 was never converted out of its source datum).
- `metashape-datum.py` (WSL Python + numpy, not part of a run) checks a reference set
  against Metashape's own adjusted block: the camera-vs-GCP datum, the antenna convention
  and a bench run's checkpoints per GCP. Usage is in its header.

## Notes

- Images are fed in sorted filename order. The UI uses whatever order the file picker
  hands over, so pair order, and with it tie-breaks, can differ slightly from a manual
  run.
- Headless Chrome on this machine exposes the same WebGPU adapter as the desktop
  browser (NVIDIA Turing). The first GPU pair of each run is still validated against
  WASM, as in the app.
- One run at a time: runs share the GPU, and timings are only comparable when nothing
  else is loading the machine.

## Linux: reaching the GPU

Headless Chrome on Linux offers no WebGPU adapter, or only SwiftShader (software)
with `--enable-features=Vulkan`. Matching and depth maps then fall back to WASM with
one `GPU requested but … no adapter` warning, and a dense stage takes hours. Run headed
with Vulkan on (it needs a display, e.g. a remote-desktop session):

```json
{ "headed": true, "chromeArgs": ["--enable-unsafe-webgpu", "--enable-features=Vulkan", "--ignore-gpu-blocklist"] }
```

Measured 2026-10-14 on the NVIDIA Turing box (driver on Chrome's GPU blocklist):
headless → SwiftShader whatever the flags; headed without `--ignore-gpu-blocklist` →
SwiftShader in workers; headed with all three flags → `nvidia / turing`. Check the
`backend = WebGPU (…)` log line: SwiftShader is slower than the WASM path.

`node scripts/bench/gpu-match-check.mjs` checks that the WebGPU matcher agrees with
WASM on this machine (planted pairs, 64² to 9000²). It found the 2026-10 miscompile on
Vulkan/NVIDIA: the kernel's accumulator was zeroed only once, so every pair wider than
one 64-column tile came back with 0 matches and each run fell back to WASM after its
first validation (match.wgsl now zeroes it explicitly).

## Texture lab

`textureLab.mjs` reruns the mesh texture in Node on a real project, about 30 s per run
instead of a browser pipeline run per change. The `texturedump` stage writes its inputs
(the newest untextured mesh and every registered camera with its frame model) next to
the run:

```sh
node scripts/bench/run-bench.mjs --config … # stages …,mesh,decimate,texturedump
node scripts/bench/textureLab.mjs --dump <out> --out /tmp/lab [--opts '{"smoothness":1}'] [--pages] [--glb lab.glb]
```

Photos are read from the dataset folder and decoded with ffmpeg (cached under `--out`);
lens, self-cal and film maps are built as the worker builds them, and masks are not
applied. It prints the run summary, including `seams` (the mean colour step across seams,
in levels, the figure the T4 work was measured with); `--pages` writes the atlas pages
and `--glb` the textured mesh. The `meshexport` stage exports the browser's own textured
mesh as GLB and OBJ.

## Historical blocks (`hist`)

`hist/` scores film and satellite frame blocks (the Grenoble benchmark layout:
`preprocessed_images/`, `image_mask.tif`, `gcp.csv`, `camera_model_intrinsics.csv`,
reference DEMs) the same way for websfm, COLMAP and Metashape:

- config key `hist` (`hist/histSetup.mjs`): the certificate focal + scan pitch on one
  sensor, the static mask on every image (or `hist.masks`, a folder of per-image masks
  imported through Masks ▸ Import folder), GCPs as control with every Nth as a
  checkpoint, and after the `dem` stage the DEM as `<out>.dem.tif`, scored against
  `hist.refDem`. The recon result carries `gcpResiduals` (control / checkpoint RMS in
  the CRS). Set `crs` to the GCPs' projected CRS and `dem: { "crs": "project" }`.
- `hist/colmap_hist.py`: COLMAP defaults (one camera, certificate focal as the prior),
  GCP similarity with leave-one-out checkpoints, PatchMatch, fusion, DEM.
- `hist/metashape_hist.py`: Metashape defaults (High), the same GCP split, depth maps,
  DEM.
- `hist/score_dem.py`: DEM − reference over their overlap on the reference grid
  (bilinear), mean / median / std / RMSE / NMAD — the protocol of the earlier
  Metashape evaluation (`historic_sfm` ▸ dem_diff.json), reproduced to the cell count.

Python scripts need an interpreter with rasterio (+ Metashape for the last); the
`hist_env3` conda env has both.

## Synthetic satellite blocks (`synth/`)

`synth/synth_sat.py` renders a strip of frame-camera scans of a fractal terrain on the
WGS84 ellipsoid (default: the KH-9 mapping camera, 304.8 mm over 46 × 23 cm film from
170 km, 70 % forward overlap) and writes them in the `hist` layout with the truth beside
them: `images/`, `camera_model_intrinsics.csv`, `gcp.csv`, `truth_dem.tif` (ellipsoidal
heights in the projected CRS), `truth.json` (poses, GSD) and a ready `bench.json`.
Rays are intersected with the terrain in ECEF, so Earth curvature is in the images.

    python synth/synth_sat.py <out> --pitch-mm 0.112    # 6 × 4107×2054, ~2 min
    python synth/synth_sat.py <out> --pitch-mm 0.028    # 6 × 16k×8k (¼ of KH-9 native)
    python synth/synth_sat.py <out> --pitch-mm 0.028 --frames 4 --reseau-mm 10 \
        --film-warp-um 100 --scan-rot-deg 0.3 --scan-shift-px 40   # SAT-5: reseau + deformed film

`exportCloudsProject: true` in a config writes the sparse (with view counts) and dense
clouds in the project CRS after recon / dense (`<out>.sparse.project.bin`, Float64), and
`synth/score_points.py <truth_dem.tif> <bins…>` scores their heights against the truth.
`hist/residual_trend.py <run.json> <truth.json | gcp.csv>` fits each recon stage's GCP
residuals against distance from the block centre (a bowl shows as dU ~ r², SAT-6).
Run both with the hist_env3 interpreter.

**Rerunning products on a kept project.** `profile: <dir>` keeps the browser profile (and
so its OPFS) in that folder instead of deleting it after the run. A later config with the
same `profile` whose `stages` start with `reopen` skips the image import and restores the
newest project (or the one named by `project`), so ortho or DEM variants rerun without
detection, matching or dense. Product stages take a settings suffix: `ortho:gm` reads the
settings object under the `"ortho:gm"` key. `exportOrthoCog: true` also writes each
ortho's full-resolution COG next to the summary (`<out>.<label>.ortho.tif`), for crops.

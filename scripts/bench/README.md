# Headless pipeline bench

Runs the real app pipeline: ingest, then SIFT detection, then matching, then sparse
SfM. It runs on a folder of images in headless Chrome, with no clicking. It drives the
same Pinia stores, worker pool, WebGPU matcher and OPFS persistence as the UI. Each run
gets a fresh on-disk browser profile, deleted afterwards, so it starts from an empty OPFS.
The profile is on disk because an incognito context keeps OPFS and blobs in memory, and
a multi-GB dataset exhausts that.

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
- `sceneType`: `object` or `aerial`.
- `detect`, `match`, `recon`: settings layered over the app's defaults, exactly as the
  modals do it. `preset` selects a preset delta (`low` / `high`).
- `stages`: default `detect,match,recon`.
- `variants`: `[{ label, match?, recon? }]`. Detection runs once; each variant then
  re-matches only when its match settings change, and always reconstructs. Use this
  for SfM-only experiments on identical inputs.
- `dev`: use the Vite dev server instead of a frozen build (faster to start). Any
  source edit then reloads the page mid-run.
- `build <dir>`: reuse an earlier snapshot. `headed`: show the browser window.
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
the quadratic term at the 95 % radius; positive means a bowl).

## More config keys

- `recursive: true`: walk sub-folders (a MicaSense SET splits captures into 000/001/…).
  The image name is the basename.
- `minGpsAlt`: drop images whose EXIF GPS altitude is below this, for example ground
  captures before takeoff.
- A variant's `recon.leverArm: true` sets `reference.leverArm` on every sensor
  (`gnssLeverArm`), so camera priors are treated as antenna positions. Without it the
  arm is used only to evaluate camera positions.
- `stallMinutes` (default 30): abort the run when no log line arrives for this long,
  or at once if the page crashes. A worker that dies of memory otherwise leaves the
  bench waiting forever. Each stage also logs the renderer heap before/after a GC.
- `reference.markOffsetsPx: [-0.5, 0.5]` re-scores the checkpoints at shifted mark
  conventions on the same model; `reference.excludeGcps` keeps known-bad GCPs out of
  the RMS (they are still listed).
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

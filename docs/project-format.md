# The project format

A WebSfM project is a folder: in the browser's Origin Private File System, in a folder
on disk the user picked, or zipped as a `.websfm` file (the same layout with a
`manifest.json` in front). This page lists what the folder holds, and the rule for
changing any of it.

## Changing the format

A project saved by WebSfM opens in every later version. `project.json` records the
format it was saved in (`formatVersion`, [`src/core/projectFormat.js`](../src/core/projectFormat.js)).

- **An added field** whose absence has a safe meaning (an older project simply lacks
  it) changes no version: the code that reads it supplies the default
  (`data.scaleFit ?? null`).
- **Any other change** that older projects cannot satisfy (a field renamed or moved, a
  new structure, a value whose meaning changed, a file moved) raises
  `PROJECT_FORMAT_VERSION` and adds, in the same commit, a step to
  `FORMAT_MIGRATIONS` in [`src/core/formatMigrations.js`](../src/core/formatMigrations.js)
  that turns the old documents into the new ones. The step is pure (JSON in, JSON
  out) and has a unit test. When the app opens an older project, it migrates the
  project in its own storage before anything reads it, keeps a copy of each document
  it rewrites (`<name>.v<n>.bak`), and logs one line per step.
- **A binary file** (keypoints, depth planes, cloud sidecars, octrees, rasters) is
  never rewritten by a migration. A change to one either reads both layouts, or its
  migration step drops the product's record, so the product is computed again.
- **Then make the new fixture:** `node scripts/fixtures/make-project-fixture.mjs <work
  dir>` saves a small project in the new format under
  `tests/fixtures/projects/v<n>/`. Commit it, and keep the older ones:
  [`tests/browser/project-format.spec.js`](../tests/browser/project-format.spec.js)
  opens every one of them and checks that it holds what it held when it was saved.
- `PROJECT_FORMAT_MIN` rises only at a release, which says so in the CHANGELOG; a
  project older than that is refused with a message, and its fixture is deleted.

A unit test fails when `FORMAT_MIGRATIONS` has no step for a version between
`PROJECT_FORMAT_MIN` and `PROJECT_FORMAT_VERSION`, and the browser test fails when no
fixture of the current version exists.

## What a project folder holds

"Recompute" says what is lost when the file is missing: *cheap* files are rebuilt on
open or on demand, *a run* means the user has to run that step again, and *user data*
cannot be recomputed at all.

| Path | Written by | Contents | Recompute |
| --- | --- | --- | --- |
| `project.json` | `useImagesStore`, `useProjectsStore` | name, scene type, CRS (and fetched CRS definitions), the image list with each image's metadata and status, image groups, `formatVersion` | user data |
| `sensors.json` | `useSensorsStore` | cameras: size, pixel size, focal length, principal point, distortion, fiducial or reseau calibration | user data |
| `images/<uuid>` | `useImagesStore` (ingest) | the original photos, as imported | user data |
| `masks/<uuid>.png` | `useImagesStore` (masks) | image masks | user data, or a run (Auto mask) |
| `images-derived/` | `useImagesStore` (thumbnails) | thumbnails and transcoded previews | cheap |
| `keypoints/<uuid>.bin`, `keypoint_colors/`, `descriptors/` | `useImagesStore` (detection) | features per image | a run (Detect) |
| `matches/matches.json` + `.bin` sidecars | `useMatchesStore` | every pair's matches, fundamental matrix, counts and flags, as one packed document ([`matchStorage.js`](../src/core/features/matchStorage.js)) | a run (Match) |
| `reconstruction.json` + `.bin` sidecars | `useReconstructionStore` | the clouds and meshes (sparse, dense, imported, edited) with cameras, tracks, colours, normals, texture; georeference, run summaries ([`opfs/reconstruction.js`](../src/utils/opfs/reconstruction.js) lists the sidecars) | a run (Sparse, Dense, Mesh) or user data (imports, edits) |
| `lod/<name>.lod`, `.hier`, `.copc.laz` | `useReconstructionStore` (cloudLod) | level-of-detail octrees of big clouds; an imported COPC file | a run, or user data (a streamed import's only copy) |
| `depthmaps/index.json`, `<uuid>.{depth,cost,nrm,rgb}.bin`, `<uuid>.png` | `useReconstructionStore` (dense) | depth maps and their previews ([`opfs/depth.js`](../src/utils/opfs/depth.js)) | a run (Depth Maps) |
| `products/<stem>.json` + `.bin` sidecars | `useReconstructionStore` (products) | DEMs and orthophotos: grid, geotransform, CRS, rasters, COGs, previews ([`opfs/products.js`](../src/utils/opfs/products.js)) | a run (DEM, Orthophoto) |
| `external/index.json`, `<id>.{bin,cog,src}` | `useExternalStore` | imported reference rasters (DEMs, orthophotos) and their display planes | user data (the import) |
| `gcps.json` | `useGcpsStore` | ground control points, check points and markers with their image marks | user data |
| `poses.json` | `usePosesStore` | imported or EXIF camera positions and orientations | user data |
| `scalebars.json` | `useScaleBarsStore` | scale bars between two markers | user data |
| `measurements.json` | `useMeasurementsStore` | saved measurements | user data |
| `footprints.json` | `useFootprintsStore` | vector sets: image footprints, contours, imported polygons | a run, or user data (imports) |
| `workflows.json` | `useWorkflowsStore` | Workflow Builder graphs and their run records | user data |
| `runs/<stage>.json` | the stage's run (detect, match, depth) | a run journal while the run is under way ([`runJournal.js`](../src/core/runJournal.js)); left behind by a tab that died, it lets the run continue; never archived | — |
| `log.ndjson` | `useLogStore` | the console, one line per entry; never archived | — |
| `<name>.v<n>.bak`, `format-migration.json` | format migration | the copies a migration kept, and its progress while it runs; never archived | — |

Some documents carry their own `version` field as well (`reconstruction.json`,
`depthmaps/index.json`, `external/index.json`, `measurements.json`, fiducial
calibrations). A reader may check it, but `formatVersion` is what decides whether and
how a project is migrated.

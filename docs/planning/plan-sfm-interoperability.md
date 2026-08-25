# Plan: SfM interoperability hub and full COLMAP workspace exchange

> **Status (2026-08-17): implemented 2026-08-06.** Remaining acceptance work is the
> real-application and large-browser verification matrix at the end of this document,
> tracked as `VERIFICATION.csv` ▸ `IOP-01`…`IOP-08`.
> Delete this file once those rows are signed off.

## Outcome

Replace the narrow **COLMAP Model** ribbon action with an interoperability hub
that can inspect an external SfM dataset, explain what it contains, and import or
export selected components safely.

The first implementation target is a complete COLMAP workflow:

- `database.db`: cameras, images, keypoints, descriptors, raw matches, verified
  two-view geometry, pose priors, and (when present) rigs/frames;
- `sparse/<model>/`: registered cameras, reconstructed image poses, sparse points,
  tracks, and observations in text or binary form;
- `images/`: optional source images;
- a `.zip`, selected directory, database file, or loose model files as input.

Important: a COLMAP database is not a complete reconstruction by itself. It does
not contain source-image pixels or the reconstructed sparse 3D model. The modal
must call this out rather than promising that one `.db` file contains everything.

## Product decisions

### Ribbon

Keep **Interoperability** as the final group in both ribbons, but avoid a growing
row of application-specific buttons.

- Import: **SfM Project…**
- Export: **SfM Project…**

The import hub auto-detects the format. The export hub starts with a format
picker. A format name belongs inside the modal, where its capabilities and losses
can be explained.

Until a second importer ships, it is acceptable to label the import button
**COLMAP Project…**, then rename it to **SfM Project…** in Phase 4.

### Import is staged, reviewed, then committed

Reading a source must never mutate the current project. The workflow is:

1. Pick a database, zip, directory, or loose files.
2. Inspect in a worker and build a plain `InteropManifest`.
3. Show counts, image-name matches, models, supported/unsupported camera models,
   conflicts, estimated storage, and losses.
4. Let the user choose components and conflict handling.
5. Validate cross-component invariants.
6. Commit as one operation; on failure, leave the project unchanged.

### Default choices

- Match external images to loaded images using the existing tiered name resolver.
- Import bundled images only when the user explicitly enables it.
- Import verified matches from `two_view_geometries`, not unverified `matches`.
- Import compatible descriptors so matching can be resumed; otherwise retain the
  imported verified matches and clearly mark descriptors unavailable.
- Add a sparse reconstruction as a new cloud. Do not replace the computed model.
- Import camera calibration only for matched/imported images.
- Preserve current websfm data on conflicts by default. Replacing keypoints is an
  explicit choice because it invalidates every existing match using their indices.
- Do not make an imported model the main sparse model when one already exists.

## Canonical boundary

Add a format-neutral core representation so every adapter does not write stores
directly:

```js
InteropManifest {
  format, version, sourceName,
  images: [{ externalId, name, width, height, cameraId, bundledFile? }],
  cameras: [{ externalId, model, width, height, params, supported, losses }],
  features: [{ imageId, keypointCount, descriptorType, descriptorDim }],
  pairs: [{ imageIdA, imageIdB, rawCount, verifiedCount, hasF, hasE, hasH }],
  models: [{ externalId, name, registeredImages, pointCount, observationCount }],
  rigs, frames, posePriors,
  warnings, estimatedBytes
}
```

Parsing produces the manifest plus lazy handles for large blobs. A separate pure
adapter converts selected external records to a `WebsfmImportBundle`. Store code
only validates and commits that bundle.

This boundary owns all convention conversions:

- pixel centre convention;
- world-to-camera versus camera-to-world transforms;
- quaternion ordering and normalization;
- principal-point origin;
- camera-model and distortion mapping;
- descriptor type/normalization;
- image path/name resolution;
- pair-id decoding and feature-index ordering.

## Phase 1 — COLMAP database inspection

### SQLite reader

Use the official `@sqlite.org/sqlite-wasm` package in a dedicated worker. Import
the selected database into a temporary read-only database, query only required
columns, and close/delete it after the modal closes. Do not run SQLite on the UI
thread.

Start with current and legacy schemas:

- `cameras`, `images`, `keypoints`, `descriptors`, `matches`,
  `two_view_geometries`;
- feature-detect `rigs`, `frames`, and pose-prior tables/columns when present;
- inspect `sqlite_master`/`PRAGMA table_info` rather than assuming one COLMAP
  version.

Do not eagerly copy all match and descriptor blobs into JS during inspection.
Fetch counts and metadata first; stream selected rows during commit. Reject a
non-SQLite file or a database without the core COLMAP tables with a useful error.

### Pure COLMAP database adapter

Add `core/io/colmapDatabase.js` with tests for:

- camera parameter decoding for every documented model;
- image/camera relationships;
- float32 keypoint blobs with 2, 4, and 6 columns;
- uint8 SIFT and float32 ALIKED descriptor blobs;
- pair-id encode/decode at boundary values;
- raw and verified match decoding;
- F/E/H row-major matrices and verification configuration;
- malformed blob lengths, missing rows, zero features, and unknown models;
- schema-version feature detection.

Convert COLMAP SIFT bytes into websfm's normalized float descriptor form only
after a round-trip matcher test proves equivalence. Unknown descriptor encodings
remain non-importable, while their keypoints and verified matches may still be
imported.

## Phase 2 — COLMAP import modal and atomic commit

Add `ColmapImportModal.vue` (later generalized to `InteropImportModal.vue`) with:

### Overview

- detected source parts: database, images, and sparse models;
- database/model version and total size;
- external images, loaded-name matches, missing images, and ambiguous matches;
- one row per sparse model (`sparse/0`, `sparse/1`, …);
- compatibility warnings and data that will be skipped.

### Select data

- **Images**: match existing only / also import bundled missing images;
- **Calibration**: camera intrinsics and supported distortion;
- **Pose priors**: import when a usable coordinate convention is known;
- **Keypoints and descriptors**: coupled by default, with descriptor compatibility;
- **Matches**: verified inliers (default) or raw matches (advanced);
- **Sparse model**: choose zero, one, or several models;
- **Set as main**: available only when safe and never preselected over an existing
  main sparse model.

### Conflicts

Show a per-component decision:

- keep websfm data (default);
- replace data for matched images;
- skip conflicting images.

Replacing keypoints must also replace or remove all affected matches atomically.
Never combine matches with a different keypoint index space.

### Commit APIs

Add explicit bulk-import methods rather than mutating refs from the modal:

- images store: attach imported features/descriptors and persist them;
- sensors store: upsert external camera groups with provenance;
- poses store: import usable priors without confusing them with solved poses;
- matches store: bulk insert verified pairs and persist once;
- reconstruction store: reuse/generalize the current COLMAP sparse import path.

Commit order is images → sensors/priors → features → matches → sparse models.
Stage OPFS writes under temporary names and publish only after validation. Report
a final imported/skipped/conflicted summary.

## Phase 3 — Full COLMAP workspace input

Extend routing to accept:

- a `.zip` with `database.db`, `images/`, and `sparse/`;
- a selected directory via the File System Access API when available;
- a folder-upload fallback (`webkitdirectory`);
- a loose `database.db` plus optional model/image selections;
- the already-supported loose or zipped sparse model.

ZIP inspection must be lazy. Do not inflate image files, descriptors, or large
tables merely to populate the overview. Apply existing zip path traversal and
size-limit protections.

If a workspace contains dense artifacts, recognize and report them:

- `dense/fused.ply` can route through the existing point-cloud importer;
- meshes supported by the existing geometry importer may be offered;
- depth-map workspaces are reported but deferred until websfm has a compatible
  per-view depth interchange contract.

## Phase 4 — COLMAP database/workspace export

Add export modes:

1. **Sparse model only** — current `.txt`/`.bin` zip behavior.
2. **Database** — SQLite with cameras, images, keypoints, compatible descriptors,
   raw/verified matches, and two-view matrices.
3. **Workspace** — database + sparse model + optional images in a zip or chosen
   directory.

The export modal shows availability before selection. For example, database
export can include descriptors only when they still exist and have a COLMAP-safe
encoding. Exported IDs must be deterministic, positive, non-zero, and consistent
across the database and sparse model.

Round-trip acceptance:

- open the database in COLMAP's database manager;
- run COLMAP mapper from the exported database and images;
- import websfm's exported workspace back into a clean websfm project;
- preserve image/keypoint/match indices and sparse track observations;
- compare camera matrices, points, and reprojections within explicit tolerances.

## Phase 5 — More formats

Add formats only where they cover a distinct workflow instead of duplicating what
COLMAP already bridges.

### 5A: NeRF / Gaussian Splatting — ship first

The exporter already creates `transforms.json`; expose it directly in the
interoperability modal instead of hiding it under **Model JSON**. Add import for
the common nerfstudio/Instant-NGP convention, with a camera-axis preview and an
explicit distortion-support report.

Why first: much of export is already implemented, the format serves a different
ecosystem, and it is a compact JSON adapter.

### 5B: OpenMVG `sfm_data.json` — bidirectional

Import/export views, shared intrinsics, poses, landmarks, and observations. Keep
JSON as the browser-native supported form; do not implement OpenMVG's cereal
binary container in JavaScript.

Why second: it is a full open SfM scene representation with tracks and shared
intrinsics, not just geometry.

### 5C: VisualSFM NVM v3 — bidirectional compatibility

Support one model initially, then multiple models. NVM includes filenames,
cameras, sparse points, and measurements in one text file and is also exported
by Metashape.

Why third: simple and useful for legacy datasets, but it has a narrower camera
model and is no longer the best primary interchange format.

### 5D: OpenSfM `reconstruction.json` — import first

Map cameras, shots, and sparse points. Treat missing point observations/tracks as
a capability loss: the model can be viewed and evaluated where possible but
cannot automatically drive all downstream reconstruction stages.

### Deferred

- **Bundler `bundle.out`**: legacy, lossy camera model, and commonly needs a
  companion image list. NVM covers the same users more cleanly.
- **Metashape XML / RealityScan alignment components**: proprietary/native
  formats add maintenance burden while both applications can exchange COLMAP;
  reconsider only for a demonstrated workflow COLMAP cannot preserve.
- **OpenMVS `.mvs`**: binary Boost/native structure and dense-pipeline semantics
  are a poor browser target. Use COLMAP/OpenMVG for cameras plus PLY/mesh formats
  for geometry.
- **AliceVision/Meshroom `.sfm`**: evaluate after OpenMVG; do not assume the two
  JSON schemas are interchangeable.

## Phase 6 — Generalize the UI

Once two import adapters exist:

- rename the ribbon entry to **SfM Project…**;
- convert the COLMAP modal into a format-neutral shell with adapter-provided
  capability rows and options;
- remember last export format, not import choices;
- add console commands (`import sfm`, `export sfm`) that open the same modal;
- keep point-cloud/mesh and raster exchange in their existing Geometry/Product
  flows rather than duplicating them in Interoperability.

## Verification matrix

Every adapter needs fixtures from the producing application, not only synthetic
files.

| Case | Required checks |
| --- | --- |
| COLMAP text and binary model | Existing parser tests plus real round-trip |
| Database, SIFT | keypoints, descriptors, raw/verified matches, F/E/H |
| Database, ALIKED | float descriptors and unsupported-consumer behavior |
| Multiple cameras/models | shared intrinsics, model selection, no ID collision |
| Partial dataset | DB only, model only, images missing, descriptors missing |
| Name conflicts | exact path, basename, stem, ambiguous and unmatched |
| Camera models | supported mapping plus explicit distortion-loss warning |
| Large database/zip | bounded inspection memory, cancellation, progress |
| Persistence | close/reopen project with all imported data intact |
| Failure | no partial store or OPFS changes |
| Export | COLMAP opens it and mapper consumes it |

Run `npm test`, `npm run typecheck`, and `npm run build` for every phase. Add a
manual Chromium/Firefox/Safari matrix for file, directory, worker/WASM, OPFS, and
large-archive behavior.

## Recommended delivery order

1. Phase 1 database inspection and fixtures.
2. Phase 2 review modal and atomic import.
3. Phase 3 complete workspace/zip/folder input.
4. Phase 4 database and workspace export.
5. Phase 5A transforms import + dedicated export choice.
6. Phase 5B OpenMVG.
7. Phase 5C NVM.
8. Add OpenSfM or deferred formats only from real user demand.

This order makes COLMAP genuinely complete before widening the format list and
keeps the ribbon stable while the interoperability surface grows.

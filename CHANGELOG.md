# Changelog

Notable changes to websfm. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Workflow Builder**: arrange pipeline steps as blocks, choose per step whether to
  reuse or rerun existing results, and save recipes and run history with the project.
- **Tools menus with floating toolboxes**, plus many new tools:
  - point clouds: normals, transform, point-pair alignment, ICP, cloud-to-cloud and
    cloud-to-mesh distance, sections;
  - meshes: clean, smooth, decimate, crop, sample to points, area and volume;
  - DEMs: contours (GeoJSON/DXF), slope, aspect, hillshade, clip to polygon;
  - model: optimize cameras, region of interest, orient model;
  - images: image quality.
- **Measurements** on DEMs, orthophotos and the 2D map: ruler, area, elevation
  profile (CSV export) and cut/fill volume. Measurements are named and saved.
- **Scale bars**: give an object capture real-world units from known distances. New
  "marker" points carry image marks but no surveyed position.
- **Rectangle and lasso selection** in the 3D viewer, to delete or keep points.
- **Gradual selection**: remove weak tie points from the sparse model and re-adjust.
- **Find GCPs**: match photos against a reference orthophoto to propose
  control-point candidates for review.
- **WebGPU feature matching**, with automatic fallback to the CPU.
- **DISK** learned detector, with its own LightGlue matcher.
- Computed DEMs and orthophotos can be shown on the 2D map. Projects without a CRS
  get a top-down map in the model's own frame.
- Orthophotos can be projected onto a DEM, the mesh or a fitted plane, at their own
  resolution.
- **Orthophotos at the photos' own ground resolution**: no longer capped at 4,096
  pixels — up to about 28,000 pixels square. They are built in blocks and stored as a
  tiled Cloud-Optimized GeoTIFF, and the orthophoto tab and the 2D map draw them at
  full resolution as you zoom in.
- One-click suggestion of a projected CRS (UTM or polar stereographic) for
  geotagged projects.
- Image groups (folders) in the sidebar, a per-sensor GNSS antenna offset, and film
  width (mm) as the scale field for film scans.
- Extra point attributes (such as intensity and GPS time) survive import and are
  written to PLY and LAS exports.
- The theme can follow the operating system.

### Changed
- Orthophotos built with an earlier version must be rebuilt (the storage format
  changed). The Cloud-Optimized GeoTIFF export is now the stored file itself (always
  DEFLATE). PNG and JPEG exports are full resolution and offered up to 8,192 × 8,192
  pixels. Orthophoto builds follow the memory budget in Settings ▸ Compute.
- Feature matching is reproducible: the same images now give the same matches in
  every project, where before a few percent of image pairs varied slightly.
- Sharper orthophotos: colour now comes from the original photos at full resolution
  instead of the lower-resolution depth maps.
- Orthophotos are now mosaicked by default: each area comes from the photo looking
  most straight down on it, exposure is balanced between photos, and seams are
  cross-faded. The previous per-pixel "Best match" and "Average" modes remain
  available.
- Dense clouds are more complete: fusion's matching-cost gate is now a fixed, looser
  default (0.8) instead of one adapted to each dataset, which was discarding real
  surface. On the ETH3D benchmark this closes the gap to COLMAP at 2 cm with no loss of
  accuracy.
- Camera positions from EXIF GPS now constrain bundle adjustment automatically.
- WebGPU is used automatically for dense depth maps when the browser supports it.
- SIFT uses RootSIFT descriptors and keeps coarse-scale keypoints first, which gives
  more multi-view tracks. Older projects are converted when matching runs.
- The default matching ratio changed from 0.75 to 0.8.
- Detection and matching settings are shown in the order they run, each with a live
  preview of its effect. A setting that would have no effect is greyed out with the
  reason.
- DEMs and orthophotos cover the dense core of the cloud by default. Choose
  "All points" to cover everything.
- Much larger projects fit in browser memory. A 347-image project now runs dense
  reconstruction at Medium quality where it was refused before, and fusion splits a
  cloud that does not fit in memory at once (tested at 69 M points).
- SuperPoint weights are no longer served by the app because of their
  non-commercial license. You can supply the file yourself.

### Performance
- Feature detection runs more images in parallel: its memory limit now follows the
  machine budget in Settings ▸ Compute instead of a fixed 1 GB.
- Project opening: the slowest step went from 11.6 s to 0.18 s on a 300 k-point
  model. Keypoints and matches now load on demand, and a progress bar names each
  loading step.
- Bundle adjustment stops once it has converged (608 → 205 s on one dataset), and
  sparse reconstruction is a further 14–50 % faster.
- Meshing is 7.4× faster end to end, and the solve itself 15× faster.
- The dense cross-view filter runs in parallel and is about 3× faster
  (444 → 101 s). Fusion is about 2× faster on large sets.
- Saving after a 3D edit writes only the clouds that changed.

### Fixed
- An orthophoto built at a chosen pixel size lost its coordinate frame, so Find GCPs
  refused it and the model-frame map could not place it.
- An imported orthophoto's tab showed "no data" under the cursor; it now reads the
  pixel's band values.
- Building a mesh from a large dense cloud (around 17 million points or more) failed
  with "Map maximum size exceeded" after the surface was solved.
- Georeferencing in polar regions was off by metres. Error-free control at 80°S now
  fits to 0.07 mm, and measurements report ground values.
- Heights in 3D Tiles exports were scaled wrongly near the poles.
- GeoTIFF import now honours the tie point and the PixelIsPoint setting. Re-import
  affected rasters to correct them.
- Meshes showed "blob" artefacts. Meshing now also uses your cleaned cloud rather
  than the first dense cloud.
- Oblique drone captures are levelled, so DEMs and orthophotos are no longer tilted.
- Datasets that start with near-stationary bursts now reconstruct fully (one
  dataset: 7 → 127 of 127 cameras).
- 16-bit TIFFs had low contrast and gave few keypoints. Large TIFF batches used
  excessive memory.
- Tiled detection created duplicate keypoints, which cost matches.
- Dense clouds: sky could survive the filters, thin tall features collapsed, and very
  large fusions crashed or were wrongly refused.
- Renaming an image detached its GCP marks, poses and footprints.
- COLMAP database export contained no descriptors for saved projects.
- "Failed to create swap file" errors in folder-backed projects.
- Images whose source file disappears during a session are recovered from the
  project copy.
- Some LAS files with 8-bit colour imported black, and some LAZ files failed to load.
- Cancelling GPU matching did not stop the run.

## [0.1.0-beta.1] — 2026-08-10

First public beta.

- Runs entirely in the browser. Projects are stored locally, can be saved and loaded
  as `.websfm` files, or kept in a folder on disk (Chromium browsers).
- SIFT and learned (SuperPoint + LightGlue) features. Pairs can be chosen by GPS
  proximity or capture sequence.
- Incremental structure-from-motion with bundle adjustment, lens self-calibration and
  Brown distortion. Scanned aerial film is supported through fiducial marks.
- Georeferencing from ground control points (with guided marking) or camera
  positions, in any proj4 CRS, including polar projections.
- Dense point clouds (optional WebGPU), screened-Poisson meshes, DEMs and
  orthophotos.
- Reference GeoTIFF DEMs and orthophotos can be imported and shown on the map.
- A Quality Report with an exportable HTML summary.
- Import and export: COLMAP models, PLY, LAS/LAZ, XYZ, GeoTIFF/COG, 3D Tiles,
  `transforms.json`, undistorted images.
- Smart (SAM2) masking, an in-app guide and a glossary.

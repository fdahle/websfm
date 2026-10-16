# Changelog

Notable changes to websfm. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [Unreleased]

### Added
- **Level-of-detail point clouds**: a dense cloud of 4 million points or more gets an
  octree in the background (saved with the project, built once), and the 3D view then
  draws only a point budget's worth of it, the part in front of the camera in most
  detail, loading the rest as you move. The budget (5 million by default) is in
  Settings ▸ Map & 3D. Selection tools still see every point.
- **Streamed LAS/LAZ import**: a LAS or LAZ file too large to hold in memory is read
  in batches straight into its octree, so a 200-million-point survey imports (in a few
  minutes) and displays; LAZ is decoded a run of chunks at a time. Such a cloud is
  marked *streamed*. Build DEM grids it (also as a DTM of its ground class), reading
  the octree only as finely as the cell size needs; Crop copies a box of it into an
  ordinary cloud; Export writes LAS, LAZ, PLY or XYZ node by node. Selection (delete,
  keep only, assign class), an inverted crop, Filter and Classify ground run on it as
  it is, node by node or tile by tile, into a new streamed cloud.
- **Measure in 3D**: Tools ▸ Measure ▸ Measure in 3D measures distance, polylines and
  areas directly in the 3D view, picked on the surface of a mesh or on cloud points.
  Lengths are split into horizontal and height change, areas into surface area and
  footprint, all in metres once the project has a georeference or scale bars.
  Measurements can be saved with the project.
- **DEM of difference**: the volume tool can measure the computed DEM against an
  imported reference DEM, reporting gain, loss and net change inside a polygon
  (Tools ▸ Measure ▸ DEM of difference).
- **Reclassify by hand**: the 3D selection toolbox has an Assign class action, so
  points the ground filter got wrong (or any selection) can be set to a LAS class.
- **Textured meshes**: Tools ▸ Mesh ▸ Texture paints a mesh with the photos
  themselves, as a new mesh with an atlas of JPEG pages. Each triangle takes the photo
  that sees it largest, neighbouring triangles keep to the same photo so seams stay
  few, and tiny charts are merged into their neighbours. Exposure is levelled per photo
  (ignoring samples one photo sees differently) and then across every seam, so the
  two sides meet. A wall hidden behind a tree is still textured from the photo that
  hides least of it, and faces no photo sees can be kept in a flat colour or removed.
  An optional photo-consistency check leaves out what only some photos saw (people,
  cars), and photos scored blurrier by Image quality are used less.
  Crop, Clean and Smooth keep the texture (Clean's weld respects it), Sample to points
  takes its colours from it, and the workflow builder has a Texture Mesh block that can
  decimate first. Masks are respected, lenses
  and film scans are sampled through their own camera model, and the depth pass runs
  on the GPU when one is available. The 3D view shows the texture (Colour by ▸
  Texture), and it exports as GLB (pages embedded), OBJ (a zip with the material
  file and the pages) and 3D Tiles.
- **Installable app that works offline**: websfm can be installed from the browser
  and starts without a connection. A new version asks before reloading, and never
  interrupts a running task. Basemap areas viewed before stay available offline at
  lower detail, and the map says when it is offline instead of looking broken.
- **New app icon**: two cameras triangulating a point. The browser-tab icon has a
  transparent background and follows the browser's light or dark theme.
- **Workflow Builder**: arrange pipeline steps as blocks, choose per step whether to
  reuse or rerun existing results, and save recipes and run history with the project.
- **Tools menus with floating toolboxes**, plus many new tools:
  - point clouds: normals, transform, point-pair alignment, ICP, cloud-to-cloud and
    cloud-to-mesh distance, sections;
  - meshes: clean, smooth, decimate, crop, sample to points, area and volume;
  - DEMs: contours (GeoJSON/DXF), slope, aspect, hillshade, clip to polygon;
  - model: optimize cameras, region of interest, orient model;
  - images: image quality.
- **Ground classification and terrain models (DTM)**: Tools ▸ Point Cloud ▸ Classify
  ground labels every point as ground, above ground or low noise (standard LAS
  classes, kept in LAS/LAZ/PLY exports) with a cloth simulation filter. Build DEM ▸
  Points ▸ Ground only then makes a bare-earth DTM, and the new Fill enclosed gaps
  option interpolates the ground under removed buildings.
- **Measurements** on DEMs, orthophotos and the 2D map: ruler, area, elevation
  profile (CSV export) and cut/fill volume. Measurements are named and saved.
- **Scale bars**: give an object capture real-world units from known distances. New
  "marker" points carry image marks but no surveyed position.
- **Rectangle and lasso selection** in the 3D viewer, to delete or keep points.
- **Gradual selection**: remove weak tie points from the sparse model and re-adjust.
- **DEM vs reference DEM** in the Quality Report (Evaluate ▸ DEM vs Reference):
  bias, NMAD, RMSE, LE90 and overlap against an imported reference DEM, with a
  difference map and histogram, also in the exported report.
- **DEM and orthophoto symbology** (Products ▸ right-click ▸ Symbology…): colour
  ramp, height range and hillshade for the DEM; brightness, contrast and gamma for
  the orthophoto. Display only, kept across rebuilds.
- **Download from the sidebar**: right-click a point cloud, mesh, DEM or orthophoto
  for its export dialog (aimed at that item), or download a reference raster or
  source image as imported, a polygon layer as GeoJSON, or the match list.
- The **DEM / Orthophoto ribbon tab** offers the same actions for a computed and an
  imported raster: a computed one gains Symbology… and Remove, an imported one
  Download.
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
- **Fiducial import and export** for film scans (Import / Export ▸ Image Fiducials
  and Camera Fiducials): each image's marks in pixels, and the camera's calibrated
  marks in mm with their slots, focal length and principal point, as CSV that
  imports back.
- **Fisheye and rational lens models**: sensors can use a Kannala–Brandt fisheye (one,
  two or four terms, as COLMAP's `SIMPLE_RADIAL_FISHEYE`, `RADIAL_FISHEYE` and
  `OPENCV_FISHEYE`) or OpenCV's rational model (k1–k6, p1, p2). Fisheye matches are
  verified in the pinhole frame and rays more than 75° off-axis are left out. Bundle
  adjustment fits fisheye cameras in the pixels the lens recorded, so self-calibration
  can refine the lens itself (up to k3) with the focal length and principal point; an
  uncalibrated fisheye (equidistant, all terms zero) reconstructs from EXIF alone. Depth
  maps use a fisheye's field up to 60° off-axis, and Optimize cameras handles fisheye
  models. COLMAP databases import these cameras instead of skipping them, and sensor CSVs read and write k4–k6 and a lens-model column.

### Changed
- **Project files past 4 GB**: a `.websfm` file is written as ZIP64 when it needs to
  be, so large projects can be saved and reopened whole. Opening a project file no
  longer reads each stored file into memory.
- **Calibration import updates sensors instead of always adding one**: Import ▸
  Calibration shows where each row goes before importing, and lets you change it. A
  row updates the sensor with its label, or the project's only sensor. With an image
  column, rows become sensors for the images they name. An update only sets the values
  the file has. The import also reads a film camera's certificate in one row (focal
  length, pixel pitch, principal point and fiducial marks in mm), and asks whether the
  focal length is in mm or pixels.
- **Image Fiducials import reads one row per image**: files with an x and a y column
  per mark position (`corner_top_left_x`, `midside_left_y`, …) are recognised on drop
  and each mark goes to the slot its columns name.
- **Fiducial imports preview first**: Image and Camera Fiducials open a dialog showing
  what will be imported (matched images, marks replaced, the target sensor) instead of
  applying the file straight away.
- **Changing the project CRS asks first**: the confirmation lists what will be
  reprojected (GCPs, camera positions, footprints) and whether the georeference has to
  be redone. Project Settings shows the CRS name, not just its code.
- **Help boxes stack**: hovering a link inside a pinned help box opens another box on
  top, and hovering a new word replaces them all. Setting labels in the pipeline
  dialogs (Detect, Match, Sparse, Depth maps, Dense, Mesh, DEM, Orthophoto) explain
  themselves on hover, without separate `?` icons. Each box shows the setting's
  current value next to its default. Every setting in these dialogs and in Auto mask
  now has a Guide section.
- **More help**: new Guide pages for masks and for working offline, a note on very
  large scans, and glossary entries for ICP, normals, contours, slope/aspect/hillshade,
  cloud distance, outlier removal, mesh smoothing and decimation, gap filling, COG,
  seamlines, image sharpness and masks, linked from the tool dialogs.
- EPSG codes from imported files, projects, GCPs and poses now resolve from the
  built-in catalog (over 7,000 coordinate systems), so they work offline. epsg.io is
  only asked for codes newer than the catalog.
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
- **SfM on big blocks**: bundle adjustment solves its camera system exactly with a
  sparse Cholesky factorisation instead of a capped iterative solve, wherever the
  block has more than about 100 cameras. Registration scans only the image pairs a new
  camera touches, and re-solves of an already converged model stop sooner. Quarry
  (347 images) reconstructs in 135 s instead of 259 s and South Building in 48 s
  instead of 85 s, with the same cameras and accuracy against RTK; 1,600 synthetic
  cameras take 97 s instead of 353 s. Start-up on a large block with a calibrated lens no
  longer re-fits every image pair's epipolar geometry up front (1,600 synthetic
  cameras: 88 s → 3 s).
- **Outlier filter (statistical)**: about 16× faster on terrain and other surface-like
  clouds (a 2 M-point survey tile: 178 s → 11 s). Its neighbour grid was sized from
  the bounding box's volume, so on a surface each point compared against thousands of
  candidates; the grid now follows the occupancy, and the neighbour search is exact
  (results unchanged to 0.01 %).
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
- Picking a CRS from the search list by clicking it did nothing in Project Settings
  and the import dialogs; the field went back to the old CRS.
- Calibration and camera-position imports no longer assign unrecognised columns by
  their position when the file has a header (a camera-position file's `x_map` became
  omega).
- **GCP import reads files with several coordinate pairs and image marks**: a point
  label column (`gcp_label`, `point_label`) is the name, a bare `x`/`y` beside an image
  column is the pixel position, `x_map`/`y_map` and `*_acc` columns are recognised, and
  lon/lat is preferred with WGS 84 preselected. A file of image marks without
  coordinates adds them to existing points of the same name, or adds markers.
- Dropped files with an `image_file_name` (or `image_id`) column are recognised: a
  camera-position list opens the camera import with lon/lat read as WGS 84, and a
  file with a `gcp_label` / `point_label` column opens the GCP import, instead of the
  "what is this file?" chooser.
- Depth maps of a two-image project (or an image only one neighbour overlaps) came out
  empty: Consistent views now drops to the number of views that image overlaps, and
  the log says so.
- Importing a mask without transparency (JPEG, plain black-and-white PNG) masked the
  whole image. Such files are now read by brightness: black is masked, white is kept.
- Very large scans: Auto mask, mask import and fiducial frame masks no longer try to
  build a canvas at full scan size, which the browser can't hold. Masks for these
  scans are stored at 8,192 px on the long side. Import, Invert and Clear work in the
  viewer; painting says it isn't available yet instead of "editing resumes…" forever.
- Orthophoto: a Max match cost the depth maps' own Minimum NCC already made
  meaningless now shows a warning instead of silently doing nothing.
- The Auto mask ribbon entry described sky/people masking it doesn't do.
- Help boxes opened from inside a dialog could not be clicked ("Read more" and their
  links did nothing).
- Help text could link a word inside another link (e.g. "SIFT" inside "SIFT
  descriptor"); stale help text was brought up to date with recent changes.
- Imported image fiducial observations were ignored by calibration and
  reconstruction until the project was reopened; they now land as detections.
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
- Images without a focal length in their metadata (no EXIF) reconstructed on a guessed
  field of view that could be far off, which broke scenes or left most cameras out.
  The focal length is now estimated from the matched image pairs first (ETH3D
  playground and terrace: from broken to 34 of 38 and 23 of 23 cameras).
- A camera could be registered in the wrong place and stay there. After the
  reconstruction, each camera is now checked against the matches with its strongest
  partner images; cameras that disagree are taken out and registered again, or left
  out if they still disagree.
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
- COLMAP database import dropped the k4–k6 terms of `FULL_OPENCV` cameras without a
  warning.
- The same matches could reconstruct slightly differently in different sessions (the
  solver's input order followed random image ids); it now follows image names.

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

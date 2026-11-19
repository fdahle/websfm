---
id: import-sfm
title: Import an SfM project
summary: Brings cameras, calibration, keypoints, matches and a sparse model from COLMAP, Metashape, Bundler, VisualSFM, OpenMVG, OpenSfM or a transforms.json into this project, and markers, scale bars and a mesh from Metashape.
category: Reconstruction pipeline
order: 13
---
**Import ▸ SfM Project** reads another tool's work into the open project: a
calibration to start from, matches you trust, or a whole sparse model to densify here.
Its dialog starts with the format, **COLMAP**, **Metashape** or **Other SfM**, then
asks for the files or their folder. Load the photos first; every file names its images, and only
those found in the project are imported.

After you pick the files, a dialog shows what they hold (cameras, keypoints, matches,
sparse models) and how many of their images are in the project, and you tick what to
bring in. Nothing changes until **Import selected**.

## COLMAP
Pick `database.db`, a sparse model (`cameras`, `images`, `points3D`, as `.txt` or
`.bin`), a ZIP of them, or the whole workspace folder. From the database come the
camera calibration, the keypoints, compatible SIFT descriptors and the matches, either
the verified inliers or the raw matches. Matches need the keypoints imported with them,
since they count keypoints by their place in COLMAP's list. A ZIP or folder with an
`images/` folder can also add the photos the project lacks. A sparse model keeps each
camera's lens (COLMAP's SIMPLE_RADIAL, RADIAL, OPENCV, FULL_OPENCV or OPENCV_FISHEYE):
the imported model carries it, and depth maps and other products built from it use it,
whatever lens the project's camera groups have.

## Metashape
Pick the XML file Metashape writes with **File ▸ Export ▸ Export Cameras**, or with
**Export Markers**, which holds the same and the markers too, or a whole project: a
`.psz` file, or the folder that holds a `.psx` and its `.files` folder. Use it to carry
work done in Metashape into WebSfM: a calibrated camera, an alignment to start from, or
GCPs you have already marked. Metashape names its cameras by photo name.

You choose what comes:

- **Calibration**: each Metashape camera becomes a camera group with its focal length,
  principal point and lens distortion (k1–k3, p1, p2), and its photos join it. Terms
  WebSfM does not model (Metashape's k4, b1, b2) are left out, and the dialog says how
  far they move a corner of the photo.
- **Camera positions and orientations** of the aligned cameras, in the project's
  coordinate system, as priors for [Sparse Model](guide:sparse-reconstruction). The
  heights are ellipsoidal. A chunk in a local frame has no coordinates to give, so its
  cameras stay behind.
- **GCPs and markers** with the marks placed in Metashape. A marker whose reference is
  turned off comes as a check point, one without coordinates as a marker. Points join
  GCPs here of the same name. Metashape's own projections (the unpinned flags) are not
  marks anyone placed, so they stay behind.

- **Scale bars** between markers or between cameras, with their distance and
  accuracy; one whose reference is turned off comes left out of the fit, as a check.
  A bar between markers needs them here, imported with it or already of the same name.

### From a project

A project brings the same, and from its tie points and mesh:

- **Keypoints and matches**: the tie points of each photo become its keypoints, and
  two photos that share tie points are matched, the photos Metashape did not align
  included. They carry no descriptors, so Match Features cannot add matches to them;
  Detect Features replaces them. **Check the matches geometrically again** runs Match
  Features' RANSAC on them too.
- **Sparse model**: the aligned cameras and the tie points, in Metashape's frame, in
  metres. It is an imported model: georeference it here from the camera positions or
  GCPs.
- **Mesh**, in the frame of the sparse model.

The dense cloud, depth maps, DEM and orthomosaic are stored in formats of Metashape's
own: export them from Metashape (LAS or LAZ, GeoTIFF) and bring them in with **Import ▸
Point Cloud / Mesh** or **Reference DEM / Ortho**; the dialog says which the project has.

### Back to Metashape

**Export ▸ SfM Project ▸ Metashape XML** writes the registered cameras, their
calibration, the GCPs with their marks and the scale bars between them, for **File ▸ Import ▸ Import Cameras** and
then **Import Markers** in Metashape (the same file for both). A georeferenced project
goes out in WGS 84 with ellipsoidal heights, converted from EGM96 or EGM2008 where
the georeference uses one; otherwise the cameras stay in a local frame. Each camera
group's lens, including what self-calibration added on top, is fitted to Metashape's
model; the log names a group the fit misses by more than 0.05 px. Film scans are left
out.

## Other SfM tools
- **Bundler:** `bundle.out` and the `list.txt` that names its images; pick both, or
  their folder. Bundler's radial distortion (k1, k2) is left out.
- **VisualSFM:** an `.nvm` file.
- **OpenMVG:** `sfm_data.json`.
- **OpenSfM:** `reconstruction.json`, cameras with their lens (perspective, Brown or
  fisheye) and points without their tracks.
- **NeRF / 3DGS:** `transforms.json`, cameras only.

Each becomes an imported sparse model, which the pipeline never overwrites. To bring in
plain keypoints and matches instead, use Import ▸ Features ▸
[Keypoints or Matches](guide:import-features).

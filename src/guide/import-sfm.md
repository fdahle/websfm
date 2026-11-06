---
id: import-sfm
title: Import from COLMAP and other SfM tools
summary: Brings cameras, calibration, keypoints, matches and a sparse model from COLMAP, Bundler, VisualSFM, OpenMVG, OpenSfM or a transforms.json into this project.
category: Reconstruction pipeline
order: 13
---
**Import ▸ COLMAP** and **Import ▸ Other SfM** read another tool's work into the open
project: a calibration to start from, matches you trust, or a whole sparse model to
densify here. Load the photos first; every file names its images, and only those found
in the project are imported.

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

## Other SfM tools
- **Bundler:** `bundle.out` and the `list.txt` that names its images; pick both, or
  their folder. Bundler's radial distortion (k1, k2) is left out.
- **VisualSFM:** an `.nvm` file.
- **OpenMVG:** `sfm_data.json`.
- **OpenSfM:** `reconstruction.json`, cameras and points without their tracks.
- **NeRF / 3DGS:** `transforms.json`, cameras only.

Each becomes an imported sparse model, which the pipeline never overwrites. To bring in
plain keypoints and matches instead, use [Keypoints & Matches](guide:import-features).

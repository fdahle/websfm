---
id: sparse-reconstruction
title: Sparse Reconstruction
summary: Solves camera poses, calibration, and a sparse 3D tie-point model from verified matches.
category: Reconstruction pipeline
order: 40
---
Sparse reconstruction turns verified matches into camera poses and 3D
[tie point](help:tie-point)s. It grows the model incrementally, registers new cameras
with [PnP](help:pnp), triangulates tracks, and repeatedly runs
[bundle adjustment](help:bundle-adjustment).

## Before you run
Inspect the match graph for disconnected groups or isolated images. A reconstruction
cannot bridge parts of the dataset that have no verified matches. Balanced is the best
first run; higher quality spends more iterations polishing a model, but cannot repair
missing overlap.

## Min correspondences
<!-- param: minMatchesForRegistration default: 20 -->
The minimum 3D–2D evidence needed to attempt registering another camera. Lowering it
may admit weak cameras but makes pose estimation less stable. If only a few images fail,
check their matches and sharpness before relaxing this gate.

## Reprojection threshold
<!-- param: reprjThreshold default: 4.0 -->
The inlier tolerance for camera-pose estimation and track filtering. It is expressed in
**detection pixels** and automatically scaled to native resolution. Lower is stricter;
raise it cautiously for imprecisely localized features or heavily downscaled detection.

## Bundle adjustment iterations
<!-- param: baIterations default: 30 -->
More iterations can improve convergence at a time cost. A large residual that does not
improve with more iterations usually points to bad matches, a poor camera model, weak
geometry, or incorrect control—not an iteration shortage.

## Self-calibration
<!-- param: refineIntrinsics default: Auto -->
**Auto** solves focal length and radial distortion for EXIF-only cameras, but preserves
an existing calibrated distortion model. Turn calibration off only when the sensor
parameters are trustworthy. Solving many parameters needs many well-distributed views;
on a weak network it can absorb scene error into implausible intrinsics.

## Check the result
Camera positions should follow the capture path, most useful images should register,
and the cloud should have coherent shape. In the Quality Report, check reprojection
error, track lengths, calibration drift, coverage, and disconnected components before
continuing to depth maps.

## Sparse gradual selection
Open **Tools → Point Cloud → Filter Cloud → Sparse gradual selection**. Choose
reprojection RMS error (select above the threshold), track length (select below),
or maximum triangulation angle (select below). The slider previews selected and
remaining counts before **Delete selected + refine**.

Refinement preserves surviving tracks and fixes camera calibration while bundle
adjustment updates camera poses and points. It is held to the same enabled ground
control and camera positions as the original solve, so it cannot undo a GCP
correction; the log states how many GCP anchors and camera positions constrained it. It refuses a disconnected camera
network, fewer than six surviving observations in any camera, or missing stored
photo measurements. Cancel or solver failure preserves the original model. A
successful edit replaces the main sparse model and invalidates depth maps, computed
dense/mesh output, DEM, orthophoto, scale and georeference; rebuild/refit those next.
Save a project copy first if you want to retain the previous solution.

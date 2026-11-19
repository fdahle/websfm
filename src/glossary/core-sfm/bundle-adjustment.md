---
id: bundle-adjustment
title: Bundle Adjustment
summary: A joint, nonlinear refinement of every camera pose and 3D point together, minimizing total reprojection error across the whole reconstruction.
refs: triggs2000, agarwal2010, nash1990
aliases: BA
---

Bundle adjustment (BA) is the final polish of the sparse reconstruction. It
refines all camera poses and 3D [tie points](help:tie-point) *at once* by
minimizing the sum of squared [reprojection errors](help:reprojection-error)
over every observation. Doing it jointly — rather than fixing cameras and points
separately — lets error spread out evenly instead of accumulating, which is what
keeps a long strip of images from drifting.

WebSfM runs a Levenberg–Marquardt solver with a Schur complement (points
eliminated first, cameras solved, points back-substituted) and analytic
Jacobians, which scales far better than a dense solve as the point count grows.
The camera system is solved exactly (a sparse Cholesky factorisation) while it fits
in the browser's memory; on a very large project, with thousands of photos that
mostly see each other, it is solved iteratively without being stored (conjugate
gradients on the implicit camera system, as Ceres' iterative Schur), which reaches
the same result in far less memory. Optionally it also refines the shared per-sensor [camera intrinsics](help:camera-intrinsics)
in the same optimisation.

![Three cameras and six points before and after bundle adjustment: before, red arrows on each image plane run from where a point projects to its measured keypoint; after, cameras and points have moved together and the arrows are gone. Beside it, the Jacobian: one row per observation, each touching one camera block and one point block.](assets/bundle-adjustment.svg)

An adaptive Huber loss down-weights outlier observations so a handful of
bad matches can't drag the whole solution off course. Setting the iteration
count to 0 skips BA entirely, leaving the incremental PnP poses unrefined.

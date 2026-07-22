---
id: bundle-adjustment
title: Bundle Adjustment
summary: A joint, nonlinear refinement of every camera pose and 3D point together, minimizing total reprojection error across the whole reconstruction.
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
Optionally it also refines the shared per-sensor [camera intrinsics](help:camera-intrinsics)
in the same optimisation.

<!-- TODO(image): assets/bundle-adjustment.svg - a small block of cameras and points before and after BA: before, each observation's projected point sits off its measured keypoint with a residual arrow; after, the arrows have shrunk. Include the sparse Jacobian block structure (camera blocks, point blocks) beside it to motivate the Schur complement. -->

An adaptive Huber loss down-weights outlier observations so a handful of
bad matches can't drag the whole solution off course. Setting the iteration
count to 0 skips BA entirely, leaving the incremental PnP poses unrefined.

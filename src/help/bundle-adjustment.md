---
id: bundle-adjustment
title: Bundle Adjustment
summary: A joint, nonlinear refinement of every camera pose and 3D point together, minimizing total reprojection error across the whole reconstruction.
---

Bundle adjustment (BA) refines all camera poses and 3D points at once by
minimizing the sum of squared [reprojection errors](help:reprojection-error)
over every observation. websfm runs a Levenberg-Marquardt solver with a
Schur complement (points eliminated first, cameras solved, points
back-substituted) and analytic Jacobians, which scales far better than a
dense solve as the point count grows.

An adaptive Huber loss down-weights outlier observations so a handful of
bad matches can't drag the whole solution off course. Setting the iteration
count to 0 skips BA entirely, leaving the incremental PnP poses unrefined.

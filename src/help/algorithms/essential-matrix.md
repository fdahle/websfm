---
id: essential-matrix
title: Essential Matrix
summary: A 3×3 matrix encoding the relative rotation and translation between two calibrated views — the algebraic core of epipolar geometry.
aliases: essential matrix, E matrix
---

The essential matrix $E$ relates corresponding points in two **calibrated**
views. For a 3D point seen as normalized image coordinates $x$ and $x'$ (rays in
each camera frame), the epipolar constraint is

$$x'^{\top} E \, x = 0.$$

It factors into the relative pose between the cameras:

$$E = [t]_\times R,$$

where $R$ is the relative rotation, $t$ the translation, and $[t]_\times$ the
skew-symmetric matrix such that $[t]_\times v = t \times v$. Because scale is
unobservable from images alone, $t$ is only known up to a scalar, so $E$ has
five degrees of freedom (three rotation, two translation direction).

When the intrinsics $K$ are unknown you work with the fundamental matrix
$F = K'^{-\top} E K^{-1}$ instead — the uncalibrated analogue used during
[epipolar geometry](help:epipolar-geometry) verification. Decomposing $E$ (via
SVD) yields four candidate poses; the correct one is the single solution that
triangulates points *in front of* both cameras (the [cheirality](help:cheirality)
check), which is why a good spread of [reprojection error](help:reprojection-error)
inliers matters for a stable recovery.

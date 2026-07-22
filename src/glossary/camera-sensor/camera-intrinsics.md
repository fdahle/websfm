---
id: camera-intrinsics
title: Camera Intrinsics
aliases: intrinsics, intrinsic matrix, calibration matrix, K matrix, internal parameters
summary: The internal parameters of a camera — focal length and principal point — that map 3D rays in the camera frame onto 2D pixels.
---
**Camera intrinsics** describe how a particular camera turns light rays into
pixels, independent of where the camera is in the world. They are collected in
the calibration matrix $K$:

$$K = \begin{bmatrix} f_x & 0 & c_x \\ 0 & f_y & c_y \\ 0 & 0 & 1 \end{bmatrix}$$

- $f_x, f_y$ — the **focal length** in pixels along each axis (usually equal for
  square pixels). Larger values mean a narrower field of view.
- $c_x, c_y$ — the **principal point**, where the optical axis pierces the
  sensor, ideally near the image centre.

<!-- TODO(image): assets/pinhole-projection.svg - the pinhole model in one figure: world point X, camera centre, optical axis, image plane at distance f, the projected pixel, and the principal point offset (cx, cy) from the pixel-array origin - annotated to match the terms of K. -->

A 3D point in the camera frame projects to a pixel via $x = K\,[R \mid t]\,X$,
where $[R \mid t]$ is the [camera pose](help:camera-pose). So
accurate intrinsics are essential: if $K$ is wrong, every triangulated
[Tie Point](help:tie-point) and every depth estimate is systematically
distorted, and it shows up as a high [Reprojection Error](help:reprojection-error).
WebSfM resolves $K$ from the sensor's physical size and focal length (via EXIF or
a manual sensor definition) and falls back to a default field of view only when
nothing better is available.

Real lenses also bend rays in ways this ideal model ignores, so accurate
intrinsics go hand in hand with a [Lens Distortion](help:lens-distortion) model.

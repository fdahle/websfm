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

![The pinhole model in side view: a world point X, the ray from the camera centre through it meeting the image plane at distance f at a pixel, the optical axis meeting the plane at the principal point, and cy measured from the pixel array origin; u = f·X/Z + cx, v = f·Y/Z + cy.](assets/pinhole-projection.svg)

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

---
id: lens-distortion
title: Lens Distortion
aliases: distortion, radial distortion, barrel distortion, pincushion distortion, brown-conrady
summary: The way a real lens bends straight lines into curves, breaking the ideal pinhole model — corrected before reconstruction.
refs: brown1966
---
**Lens distortion** is the deviation of a real lens from the ideal
[pinhole](help:camera-intrinsics) projection. Instead of mapping straight lines
in the world to straight lines in the image, a physical lens bends them: wide
lenses bow lines outward (*barrel* distortion), and some lenses pull them inward
(*pincushion* distortion). The effect grows with distance from the image centre
and is largest in the corners.

<!-- TODO(image): assets/lens-distortion.svg - a square grid shown three times: undistorted, barrel (edges bowed outward), pincushion (edges pulled inward), with an arrow field on one of them showing the displacement growing with radius from the principal point. -->

Left uncorrected, distortion pushes keypoints off their true projected positions
and inflates [Reprojection Error](help:reprojection-error), because the geometry
of the rest of the pipeline assumes a perfect pinhole camera.

WebSfM models distortion with the **Brown–Conrady** coefficients (radial terms
$k_1$–$k_3$ and tangential terms $p_1, p_2$), their **rational** extension (OpenCV's
`CALIB_RATIONAL_MODEL`, which adds $k_4$–$k_6$ in a denominator and suits wide lenses),
or a [fisheye](help:fisheye-lens) model for ultra-wide lenses. Whichever model a
[sensor](help:sensor) uses, the distortion is removed **once at ingest**: keypoints
are undistorted up front so that triangulation and bundle adjustment can treat every
camera as an ideal pinhole, and the dense stages resample each photo the same way. This
keeps the core math simple and uniform rather than threading distortion parameters
through every stage.

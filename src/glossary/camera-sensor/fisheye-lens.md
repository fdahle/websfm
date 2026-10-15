---
id: fisheye-lens
title: Fisheye Lens
aliases: fisheye, fisheye lenses, fisheye camera, Kannala-Brandt, Kannala–Brandt, equidistant projection
summary: An ultra-wide lens that maps the angle of a ray, not its tangent, to image radius — so it can see far wider than any pinhole camera.
---
A **fisheye lens** records a ray that arrives at angle $\theta$ off the optical axis
at an image radius proportional to $\theta$ itself, where a
[pinhole](help:camera-intrinsics) camera would put it at $f \tan\theta$. Because
$\tan\theta$ runs to infinity at 90°, a pinhole can never see a half-space; a
fisheye squeezes the edge of its field in instead, and action cameras, 360° rigs and
many drone wide-angle modes reach 120–190° this way. Straight lines bend strongly
everywhere except through the centre.

WebSfM uses the **Kannala–Brandt** model, the same one as OpenCV's fisheye module
and COLMAP's `OPENCV_FISHEYE`:

$$\theta_d = \theta\,(1 + k_1\theta^2 + k_2\theta^4 + k_3\theta^6 + k_4\theta^8)$$

With every $k$ zero it is the plain *equidistant* fisheye ($r = f\theta$), which is
close for most fisheye lenses when only the focal length is known. The sensor table
offers it with one, two or four terms (`Fisheye (k1)`, `Fisheye (k1,k2)`,
`Fisheye (k1–k4)`), matching COLMAP's `SIMPLE_RADIAL_FISHEYE`, `RADIAL_FISHEYE` and
`OPENCV_FISHEYE`. Note that $k_1$…$k_4$ here are terms in the ray angle, not the
Brown–Conrady radius terms of the same name.

Like any other [lens distortion](help:lens-distortion), the fisheye is removed once
at ingest so the rest of the pipeline stays pinhole. That has consequences:

- **Rays far off-axis are dropped.** A pinhole frame stretches a fisheye's rim by
  $1/\cos^2\theta$: one pixel of detection noise at 75° becomes about 15 pixels. Keypoints
  more than 75° off-axis are left out of the reconstruction.
- **Matches are verified in the pinhole frame**, where epipolar lines are straight, so
  [RANSAC](help:ransac) does not reject the curved matches near the rim.
- **Depth maps reach 60° off-axis.** Dense resamples each fisheye photo onto a pinhole
  canvas grown on each side to hold its field along the image axes, up to 60° off-axis;
  past that a pinhole pixel would be mostly interpolation. The canvas is larger than the
  photo, so depth maps take more memory than for an ordinary camera of the same size.
  The dense cloud and the orthophoto, which are built from the depth maps, cover the
  same field.
- **Bundle adjustment works in the recorded pixels.** A fisheye camera's observations are
  compared with the fisheye projection itself, not in the pinhole frame, so a pixel of
  error weighs the same anywhere in the frame, and
  [self-calibration](help:self-calibration) can refine the lens's own $k$ terms along with
  the focal length and principal point. After each refinement the keypoints are
  re-derived from the recorded pixels with the new lens, and dense products use the
  refined lens. A sensor that starts equidistant (all $k$ zero) is treated as
  uncalibrated, so **Auto** refines it; one with calibrated $k$ terms is left alone.
  Automatic and preset self-calibration refine up to $k_3$; a four-term lens keeps its
  $k_4$.

---
id: principal-point
title: Principal Point
aliases: image centre, image center, cx, cy
summary: The pixel where the optical axis meets the sensor — the image centre, stored as (cx, cy) in the camera matrix.
---
The **principal point** is where the lens's optical axis pierces the sensor: the
one pixel that a ray straight down the axis lands on. It is stored as
$(c_x, c_y)$ in the [camera intrinsics](help:camera-intrinsics) matrix, and it is
the origin that projection measures image coordinates from.

For a well-built camera it sits near the geometric centre of the image, and
initialising it to $(\text{width}/2, \text{height}/2)$ is a good default. It is
*not* exactly the centre in practice — the sensor is never mounted perfectly
concentric with the lens, and any crop, resize, or off-centre scan shifts it.
Two cases in this app move it a long way from the middle:

- **Film scans**, where the principal point is a calibrated property of the
  camera reported in its calibration certificate, recovered through the
  [fiducial marks](help:fiducial-marks) rather than assumed.
- **Tiled or cropped imagery**, where the principal point must be translated by
  the same offset as the crop.

<!-- TODO(image): assets/principal-point.svg - an image frame with the geometric centre marked as a hollow cross and the true principal point (cx, cy) offset from it as a filled dot, the optical axis arrow arriving at the latter, and the offset dimensioned. -->

**Why it matters, and why it is hard.** A wrong principal point tilts and shifts
the whole reconstruction rather than distorting it locally, so it is easy to miss
in the [reprojection error](help:reprojection-error) statistics. It is also
strongly correlated with the camera's translation: moving the principal point and
sliding the camera sideways produce nearly the same image, which is why
[self-calibration](help:self-calibration) refines it only after focal length has
settled and enough well-spread observations exist to separate the two. Refining
$c_x, c_y$ too early on a small block is a reliable way to make a reconstruction
worse while the reported error goes down.

---
id: focal-length
title: Focal Length
aliases: fx, fy, focal
summary: The distance from the lens to the sensor that sets the field of view — the fx/fy entries of the camera matrix.
---
**Focal length** is the distance from the lens's optical centre to the sensor
plane at which a distant scene comes into focus. It is what sets the field of
view: a long focal length magnifies a narrow slice of the world, a short one
takes in a wide angle.

It appears in two different units, and confusing them is a common source of
wrong reconstructions:

- **Millimetres** — the physical property, the number written on the lens and
  stored in EXIF (e.g. 152 mm for an aerial mapping camera).
- **Pixels** — what the projection math needs, the $f_x, f_y$ entries of the
  [camera intrinsics](help:camera-intrinsics) matrix $K$.

The bridge between them is the [sensor](help:sensor) size:

$$f_{\text{px}} = f_{\text{mm}} \times \frac{\text{image width in px}}{\text{sensor width in mm}}$$

so a focal length in millimetres is meaningless for reconstruction until the
sensor width is known too. $f_x$ and $f_y$ are equal for square pixels, which is
the normal case; they differ only for anamorphic pixels or a non-square scan.

<!-- TODO(image): assets/focal-length-fov.svg - two pinhole cameras with the same sensor width but short and long focal lengths, showing the field-of-view cones widening and narrowing, plus the f_px = f_mm x width_px / width_mm conversion annotated on the sensor. -->

**Why it matters.** Focal length is the parameter the reconstruction is most
sensitive to. Get it wrong and the geometry does not simply scale — it *bows*:
a too-short focal length makes a flat surface reconstruct as a dish, and the same
error propagates straight into depth maps and the DEM. WebSfM resolves $f_x$ from
EXIF plus the sensor definition where possible, and falls back to a default field
of view (focal ≈ image width) only when nothing better exists — a fallback that
is logged loudly, because it is a guess.

Because of that sensitivity, focal length is the first parameter
[self-calibration](help:self-calibration) refines, and usually the only one worth
refining on a small or weakly-constrained project.

---
id: ground-control-point
title: Ground Control Point
aliases: GCP, GCPs, ground control points, control point, control points
summary: A feature whose real-world coordinates are known from survey, marked by hand in the images to tie the reconstruction to the ground.
---
A **Ground Control Point (GCP)** is a point on the ground whose real-world
coordinates are known independently — from a GNSS survey, a total station, or an
existing map — and which is identifiable in the photos. Marking it in two or more
images gives the reconstruction something it cannot derive from imagery alone: a
link to actual coordinates.

Each GCP carries three things:

- **Surveyed coordinates** $(x, y, z)$ in the project's
  [coordinate reference system](help:coordinate-reference-system), with a
  per-axis accuracy. The accuracy is not decoration — it is the weight the point
  gets, and a GCP claiming an unrealistic accuracy will distort the fit around
  itself. Elevation especially: `z` starts as *unmeasured*, not as zero, because
  zero is a perfectly valid sea-level height and must never double as "missing".
- **Observations** — the pixel where the point appears, marked by hand per image,
  each with its own image-space accuracy.
- An **enabled** flag. Every enabled GCP is used; WebSfM does not split them into
  control and check points.

<!-- TODO(image): assets/gcp-marking.svg - the same surveyed target seen in three overlapping photos with its marked pixel in each, rays converging to one triangulated point, and that point paired by an arrow to its surveyed coordinate in the project CRS, with the residual between them labelled. -->

GCPs act at two stages. Their observations are
[triangulated](help:triangulation) into the reconstruction's own frame and paired
against their surveyed positions to fit the
[georeferencing](help:georeferencing) transform. They also enter
[bundle adjustment](help:bundle-adjustment) *directly*, as anchor residuals
pulling specific 3D points toward their surveyed positions — which corrects the
model's shape, not just its placement.

**Guided marking** makes the manual work tractable. Once cameras are posed, a GCP
already marked in one other image is constrained to an
[epipolar line](help:epipolar-geometry) in every other; marked in two or more, it
is constrained to a single predicted pixel. WebSfM draws those guides while
marking — but they are strictly advisory and there is deliberately **no
snap-to-guide**. A guide comes *from* the reconstruction, so snapping to it would
feed the model's own estimate back in as ground truth. The gap between the guide
and where you actually click is the diagnostic, and it matters most exactly when
the reconstruction is wrong.

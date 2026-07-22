---
id: georeferencing
title: Georeferencing
aliases: georeference, georeferenced, geo-referencing, absolute orientation, similarity transform
summary: Placing the reconstruction into real-world coordinates by fitting the 7-parameter similarity transform that photographs alone cannot determine.
---
**Georeferencing** (*absolute orientation* in photogrammetry) moves a
reconstruction from its own arbitrary coordinate frame into real-world
coordinates. It is needed because
[Structure from Motion](help:structure-from-motion) is inherently
**scale-free**: images constrain the shape of a scene but not its size, its
orientation, or where it sits, leaving exactly seven unknowns — 1 scale,
3 rotation, 3 translation.

Seven unknowns means a **similarity transform**, and WebSfM fits it with Horn's
closed-form method over paired points: each pair contributes the same feature's
position in the reconstruction's frame and in the real world. Three
non-collinear pairs are the minimum; more pairs both over-determine the fit and
let the residuals be reported.

<!-- TODO(image): assets/georeferencing.svg - a reconstruction in its arbitrary frame, arrows to the same block after scaling, rotating and translating onto a map grid, with three paired points connected between the two frames and the per-pair residual drawn after the fit. -->

The pairs come from either of two sources, and the choice matters:

- **[GCPs](help:ground-control-point)** — surveyed ground points marked in the
  images. Preferred whenever at least three triangulate, because they are
  independent measurements of the *ground*, and their residuals are a genuine
  accuracy statement about the result.
- **Imported [camera poses](help:camera-pose)** — the reconstruction's camera
  centres paired against a flight log or GNSS record. Always available on a
  modern survey, but it measures the aircraft rather than the terrain, and
  inherits the navigation system's accuracy.

A similarity transform can only translate, rotate and scale — it cannot bend.
So georeferencing corrects *placement*, never *shape*: if a reconstruction bows
because the [focal length](help:focal-length) was wrong, the fit will spread that
error across the GCP residuals rather than remove it. Large, systematically
patterned residuals are a message about the reconstruction, not about the fit,
which is why GCPs are also fed into
[bundle adjustment](help:bundle-adjustment) as anchors, where they *can* change
the geometry.

Once fitted, the transform is what lets a [DEM](help:digital-elevation-model) and
[orthophoto](help:orthophoto) be written as georeferenced GeoTIFFs in the
project's [CRS](help:coordinate-reference-system).

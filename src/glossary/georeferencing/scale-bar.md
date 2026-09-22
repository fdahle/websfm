---
id: scale-bar
title: Scale bar
aliases: scale bars, known distance, scale constraint, known-distance constraint
summary: A measured real-world distance between two identifiable points, used to give an otherwise up-to-scale reconstruction a metric unit.
---
A **scale bar** is a distance you measured in the real world — a ruler laid in
the scene, the spacing of two survey targets, the known baseline between two
cameras — declared between two points the reconstruction can also find. It is
how a project with no [GCPs](help:ground-control-point) and no
[CRS](help:coordinate-reference-system) gets metres.

It exists because photographs alone cannot see size.
[Structure from Motion](help:structure-from-motion) recovers the *shape* of a
scene and the *relative* positions of the cameras, but a scene twice as large
photographed from twice as far away produces identical images. Scale is one of
the seven quantities the images leave undetermined (see
[gauge freedom](help:gauge-freedom)); one measured distance fixes it.

<!-- TODO(image): assets/scale-bar.svg - the same object reconstructed at two arbitrary sizes producing identical images, with one measured distance drawn across it resolving which of the two is real. -->

**One bar is enough.** With a second bar the two rarely agree exactly, and the
fit becomes a weighted least squares over both: the scale that minimises
`Σ w·(s·d_model − d_known)²`. Every bar is then reported with its **residual**
— how far that bar's length ends up from what you entered — including the bars
that defined the fit. A disagreement between two bars is a measurement you want
to see, not one to hide.

Weighting comes from the accuracy you declare with each bar (1σ), as an inverse
variance, so a caliper measurement outranks a tape measure. A bar with no
declared accuracy is weighted equally with the others and labelled as such — it
is never presented as if it carried a surveyed uncertainty.

**Endpoints** come in two kinds:

- A **marker** — a point you mark in two or more images, exactly like a GCP but
  with no surveyed coordinates. Its position is triangulated in the
  reconstruction's own frame.
- A **camera centre** — any registered image. This costs nothing extra, because
  the centre is already part of the solution, so a calibrated rig baseline or a
  surveyed camera pair can scale a project with no marking at all.

Applying a scale never rewrites the point cloud. The factor becomes a property
of the projection frame the products are built in, which is why a re-fit is
cheap and why the depth maps, the recorded reprojection statistics and the
reconstruction's own coordinates all stay exactly as they were.

When a project *is* georeferenced, the [georeference](help:georeferencing)
already carries a scale and defines the unit; the bars are then reported as
independent **checks** against it.

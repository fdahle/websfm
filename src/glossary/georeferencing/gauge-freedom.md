---
id: gauge-freedom
title: Gauge freedom
aliases: gauge freedoms, datum defect, free-network, up to scale, up-to-scale
summary: The seven degrees of freedom — position, orientation and scale — that images cannot determine, and which therefore have to be fixed by external evidence.
---
**Gauge freedom** is the part of a reconstruction that the photographs cannot
possibly determine. Take a finished model and move it a kilometre north, spin it
about any axis, or make it twice as large while doubling every camera distance:
every image reprojects to *exactly* the same pixels. Nothing in the data can
tell those solutions apart.

There are seven such freedoms — 3 translation, 3 rotation, 1 scale — which
together are a **similarity transform**. Photogrammetry calls the same idea the
*datum defect* of a free network.

<!-- TODO(image): assets/gauge-freedom.svg - one camera-and-points configuration drawn three times (translated, rotated, uniformly scaled with the cameras) with the identical image plane projections beneath each, showing the reprojection error is unchanged. -->

Two consequences run through the whole application:

- **A length with no declared datum has no unit.** Until something external is
  supplied, every distance the app can compute is *up to scale*, and is reported
  in "model units" rather than metres. That is a statement about the evidence,
  not a limitation of the arithmetic.
- **Fixing scale afterwards is exact, not an approximation.** Because a
  similarity leaves every reprojection residual unchanged,
  [bundle adjustment](help:bundle-adjustment) is completely blind to it: a
  scale applied after the adjustment produces the *same model* that constraining
  the scale during the adjustment would have produced. This is why a
  [scale bar](help:scale-bar) is fitted post-hoc, and why doing so costs nothing
  in accuracy.

The equivalence stops holding only when two or more constraints **disagree**.
Then a constraint applied inside the adjustment would deform the geometry to
split the difference between them, while a post-hoc fit leaves the shape alone
and reports the disagreement as residuals — which is the more honest answer
while the disagreement is small, and a signal to go and re-measure when it is
not.

The freedoms are removed by external evidence: surveyed
[GCPs](help:ground-control-point) or imported
[camera poses](help:camera-pose) remove all seven at once through
[georeferencing](help:georeferencing); a scale bar removes exactly one of them.

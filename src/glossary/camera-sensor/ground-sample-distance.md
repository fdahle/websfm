---
id: ground-sample-distance
title: Ground Sample Distance
aliases: GSD, ground resolution, ground sampling distance, pixel size on the ground
summary: How much ground one image pixel covers — the resolution limit that every downstream product inherits.
---
**Ground Sample Distance (GSD)** is the size of one image pixel measured on the
ground: 5 cm GSD means each pixel spans 5 cm of terrain. It is the resolution
budget for the entire project, and no downstream product can be genuinely finer
than the imagery it came from.

For a nadir photo it follows directly from the flying height, the
[focal length](help:focal-length) in pixels, and nothing else:

$$\text{GSD} = \frac{Z}{f_{\text{px}}}$$

where $Z$ is the distance from camera to ground. Equivalently, in physical
units, $\text{GSD} = Z \cdot p / f_{\text{mm}}$ for pixel pitch $p$. Fly twice as
high and the GSD doubles; the same camera at half the range resolves twice as
finely.

<!-- TODO(image): assets/gsd.svg - a camera at height Z above terrain with its footprint on the ground, one sensor pixel traced through the lens to the ground patch it covers, GSD = Z / f_px annotated, and a second camera at 2Z showing the doubled ground patch. -->

GSD sets sensible defaults everywhere downstream, and asking for finer is asking
for interpolation rather than information:

- The [DEM](help:digital-elevation-model) cell size and the
  [orthophoto](help:orthophoto) pixel size. A DEM at half the GSD does not
  contain more terrain — it contains the same terrain plus interpolation noise.
- The dense fusion merge cell, which WebSfM sizes automatically at the median
  GSD across the block, so that one surface patch collapses to roughly one
  point.

GSD varies across a real project — terrain relief, oblique views, and changes in
flying height all move it — so a single number is always a median, and the
extremes matter for the steepest parts of the scene.

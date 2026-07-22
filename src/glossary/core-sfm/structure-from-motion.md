---
id: structure-from-motion
title: Structure from Motion
aliases: SfM, structure-from-motion, sparse reconstruction, incremental SfM
summary: Recovering camera poses and 3D scene structure simultaneously from a set of overlapping photos, with nothing but the photos as input.
---
**Structure from Motion (SfM)** solves for two unknowns at once from overlapping
photographs: the *structure* (where things are in 3D) and the *motion* (where
each camera was and how it was oriented). Neither can be found first — you need
the poses to triangulate points, and points to resect poses — so the whole field
is about bootstrapping out of that circularity and then refining everything
jointly.

WebSfM uses the **incremental** approach, which grows one reconstruction outward
from a carefully chosen seed:

1. **Match** every viable image pair and verify each geometrically with the
   [fundamental matrix](help:fundamental-matrix), producing the
   [match graph](help:match-graph).
2. **Initialise** from one pair chosen for many inliers, wide
   [baseline](help:baseline), and low initial error. The relative pose comes from
   the [essential matrix](help:essential-matrix), the first
   [tie points](help:tie-point) from [triangulation](help:triangulation).
3. **Register** the next-best image by [PnP resection](help:pnp), triangulate the
   new points it brings, and repeat.
4. **Refine** with [bundle adjustment](help:bundle-adjustment), interleaved
   rather than saved for the end, so drift is corrected before it compounds.
5. **Clean and repeat** — re-triangulate with the improved poses, merge split
   [tracks](help:track), filter high-residual points, and register whatever
   became possible.

<!-- TODO(image): assets/incremental-sfm.svg - a four-stage strip: the match graph, the initial pair with its first triangulated points, one new camera being resected against those points, and the grown block after bundle adjustment - with an arrow looping from stage 3 back to itself. -->

**The result is scale-free.** Photographs alone cannot tell a model of a quarry
from a model of a sandpit; the reconstruction is correct only up to a similarity
transform (7 degrees of freedom: scale, rotation, translation). Fixing that
requires external information — [GCPs](help:ground-control-point) or imported
camera positions — which is what [georeferencing](help:georeferencing) does.

The output of SfM is the **sparse** reconstruction: posed cameras plus a
scattering of tie points, one per matched feature. It is the input to
[Multi-View Stereo](help:multi-view-stereo), which fills in the pixels between
them.

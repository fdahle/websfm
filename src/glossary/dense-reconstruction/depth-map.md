---
id: depth-map
title: Depth Map
aliases: depth maps, depthmap, depthmaps
summary: A per-pixel array of scene depths for one image, produced by dense stereo before fusion into a point cloud.
---
A **depth map** is one image's worth of geometry: an array the same size as the
photo, where each cell holds the distance from that camera to the surface seen
through that pixel. It is the natural output of dense stereo, because depth is
estimated *in the frame of one image at a time* — a per-pixel range image rather
than a cloud.

WebSfM computes one per image with [PatchMatch](help:patchmatch), and stores
alongside the depth two companion planes that later stages depend on: a **cost**
plane (how well the winning depth's patch matched the source views, the
[photometric consistency](help:photometric-consistency) score) and a **normal**
plane (the orientation of the small surface patch that won at that pixel). The
normals are reused later as the input to meshing, so they are not a debug
by-product.

<!-- TODO(image): assets/depth-map.svg - a source photo next to its depth map rendered in a near-to-far colour ramp, with a single pixel traced along its viewing ray to the surface, the ray length labelled as the stored depth, and the fitted surface patch normal drawn at the hit point. -->

**Depth maps are cleaned before they are used.** Three passes run in order: a
median/speckle filter that removes isolated wrong depths within one map; a
**cross-view consistency** pass that reprojects each pixel through a neighbouring
view's own depth and back, keeping only pixels several views independently agree
on; and finally fusion. That middle pass is the only stage that can remove sky
and vegetation, because both correlate well photometrically — a textured bush
matches itself, and smooth sky matches at *any* depth — and give themselves away
only by disagreeing between views.

Fusion then merges the surviving pixels from every map into one dense
[point cloud](help:point-cloud), collapsing the near-coincident copies of each
surface that k overlapping views produce.

Depth maps are the one product WebSfM **persists rather than recomputes**, since
a map costs minutes per image to build. They are stored per image and loaded
lazily on first use, and they are stamped with the sparse cloud they were
computed against: re-running the reconstruction moves the cameras, so the stored
depths no longer describe the same frame and the whole set is discarded.
Orthophoto generation reuses them a second time, as a z-buffer for deciding which
surface is visible in each direction.

---
id: point-cloud
title: Point Cloud
aliases: point clouds, dense cloud, dense point cloud, sparse cloud, sparse point cloud
summary: A set of 3D points with colours and often normals — the common currency between the reconstruction stages and the usual delivery format.
---
A **point cloud** is the simplest useful 3D representation: a list of points,
each with a position, usually a colour, sometimes a normal. It has no surface, no
topology, no notion of what is connected to what — which is exactly why it is a
good intermediate. WebSfM produces two kinds, and they differ in more than
density.

**Sparse cloud.** The output of
[Structure from Motion](help:structure-from-motion): thousands to a few hundred
thousand [tie points](help:tie-point), one per matched feature. Each point
carries its [track](help:track) — the list of images that observed it and the
pixel in each — which is what makes it a *model* rather than a picture. Those
observations are what [bundle adjustment](help:bundle-adjustment) optimises, what
[GCP](help:ground-control-point) residuals are computed against, and what the
quality report analyses. Points only appear where features could be matched, so
a snowfield is nearly empty and a rock outcrop is dense.

**Dense cloud.** The output of [Multi-View Stereo](help:multi-view-stereo):
millions to tens of millions of points, fused from the per-image
[depth maps](help:depth-map), with per-point normals inherited from the
PatchMatch planes. It has no per-point tracks — it is geometry, not a model —
and it is stored as flat typed arrays rather than point objects, because
materialising thirty million objects is the difference between working and
running out of memory.

<!-- TODO(image): assets/sparse-vs-dense.svg - the same scene as a sparse tie-point cloud (with one point's track drawn back to three images) and as a dense cloud, side by side at the same viewpoint, with point counts labelled. -->

Fusion needs one more step than "keep everything". A surface seen by $k$ cameras
produces $k$ near-coincident copies of itself — a shell — so kept pixels are
accumulated into world-space voxel cells and averaged to one point per cell. The
cell size is chosen at the median [GSD](help:ground-sample-distance), so that one
ground pixel becomes roughly one point. **Density is controlled by that cell
size, not by how many input pixels are sampled**; sub-sampling the input is a
speed lever that trades evidence for time.

Clouds can also be **imported** (PLY, LAS, XYZ) as reference data — lidar, or an
earlier survey. Imported clouds land verbatim in the current frame with no
reprojection, and the pipeline never overwrites them. The dense cloud is the
input to [meshing](help:mesh), the [DEM](help:digital-elevation-model), and the
[orthophoto](help:orthophoto).

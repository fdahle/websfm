---
id: multi-view-stereo
title: Multi-View Stereo
aliases: MVS, dense reconstruction, densification
summary: Estimating depth for nearly every pixel across overlapping views to turn a sparse reconstruction into a dense point cloud.
---
**Multi-View Stereo (MVS)** is the stage that turns the sparse skeleton of a
reconstruction into dense geometry. Where standard SfM only recovers 3D
coordinates for distinct [Tie Points](help:tie-point), MVS reuses the solved
camera poses and [Camera Intrinsics](help:camera-intrinsics) to estimate depth
for *nearly every pixel* in the source images.

WebSfM does this in two stages. First it builds a **depth map** per image with a
PatchMatch search: each pixel proposes a small oriented surface patch, the patch
is projected into neighbouring views, and the depth whose patch best matches
across those views is kept — good guesses propagate to their neighbours over
several sweeps. Second, the per-image depth maps are **fused** into a single
point cloud, keeping only depths that several views agree on so noise and
occlusions are culled.

<!-- TODO(image): assets/mvs-pipeline.svg - a four-panel strip: posed cameras over a sparse cloud, one image's PatchMatch depth map, the same scene as several overlapping per-view depth maps, and the fused dense cloud - with the discarded pixels between panels 3 and 4 marked as cross-view disagreement. -->

The result is a dense 3D [point cloud](help:point-cloud) — the raw material for the survey products:
the [Digital Elevation Model](help:digital-elevation-model) (terrain height) and
the [Orthophoto](help:orthophoto) (map-accurate imagery). Its quality depends
directly on correct intrinsics: an inaccurate focal length bends the recovered
surface.

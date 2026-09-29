---
id: dense-cloud
title: Dense Cloud
summary: Fuses consistent depth-map samples into a coloured point cloud with normals.
category: Dense reconstruction
order: 60
---
Fusion is Stage B of dense reconstruction. It cross-checks depth maps, merges agreeing
samples, and emits a coloured [point cloud](help:point-cloud) with normals for meshing.

## Auto thresholds
<!-- param: auto default: Enabled -->
Auto derives the minimum view count and maximum PatchMatch cost from the current data.
Leave it on unless you are diagnosing a specific completeness-versus-noise tradeoff.

## Depth agreement tolerance
<!-- param: depthTolPct default: 1.0% -->
How closely reprojected depths must agree. Lower values make a cleaner, sparser cloud;
higher values retain more surface but can thicken edges and duplicate layers.

## Point density
<!-- param: step default: 1 px -->
Emit one point every N depth-map pixels. `1` keeps full available density. A larger
step is a direct, predictable way to make a smaller cloud for preview or export.

## Geometric outlier filters
Minimum triangulation angle removes near-parallel evidence such as sky and distant
haze. Maximum incidence angle removes surfaces seen almost edge-on. Isolated-point
cleanup targets unsupported fusion flyers. Keep the defaults unless they remove a
real thin structure you care about.

## Cleaning the cloud
Use the 3D viewer to inspect floating clusters, edge shells, holes, and over-smoothed
areas. Cloud filtering can remove statistical outliers or isolated components, but
systematic defects are better fixed in the depth maps, masks, or source imagery.


## Saved depth maps and memory
After depth maps are saved, their pixel arrays are released. Building a dense
cloud reads one reference map and one comparison map at a time; orthophoto
generation reads one map at a time. The same consistency and blending rules apply.
This reduces resident input memory, though the merged point cloud and its output
still need memory. Unsaved maps remain in memory if project storage is unavailable.
The memory estimate shown before fusion includes the streamed inputs and scratch
arrays. Streaming may trade repeated disk reads for a lower memory peak.

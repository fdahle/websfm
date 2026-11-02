---
id: filter-cloud
title: Filter Cloud
summary: Thin a dense cloud and remove its noise — height and brightness range, voxel thinning, isolated clusters and statistical outliers — into a new cloud.
category: Tools
order: 120
---
**Tools ▸ Point Cloud ▾ ▸ Filter…** removes noise and thins a dense cloud, computed or
imported. It runs the steps you turn on in their order (range, voxel thinning, isolated
clusters, statistical outliers) and adds the result as a new cloud; the source stays.
**Remove outliers…** and **Subsample…** open the same dialog with one step on.

Run it before meshing or a DEM when the cloud shows floating specks, or to make a large
cloud lighter to view and export. Sparse models are cleaned with
[gradual selection](guide:sparse-reconstruction) instead.

## Preset
<!-- param: preset  default: Balanced -->
**Light** removes only clear flyers, **Balanced** removes outliers at 1.5 σ, **Strong**
also removes isolated clusters and cuts at 1.0 σ. Start with Balanced; take Strong for a
noisy cloud of a solid surface, Light where thin detail (wires, railings, branches)
must survive.

## Elevation (Z)
<!-- param: zRange  default: unbounded -->
Keeps only points between these heights, in the cloud's units. Use it to cut away sky
noise above a site or points far below the ground. Leave a field empty for no limit
on that side.

## Brightness
<!-- param: lumaRange  default: unbounded -->
Keeps only points whose colour brightness (0–255) lies in this range. A minimum of
10–20 removes black edge points from photo borders or masks; a maximum removes washed
out sky. Ignored on a cloud with no colour.

## Voxel cell size
<!-- param: voxelCell  default: 0 (auto) -->
Thinning keeps one averaged point per cube of this size. **0** uses the dense run's
merge cell, or about one point spacing on an imported cloud: the density evens out
with little loss. A larger cell makes a lighter cloud, for viewing or a coarse DEM.

## Cluster cell size
<!-- param: isolatedCell  default: 0 (auto) -->
The grid that isolated clusters are found on. **0** uses about four point spacings.
Raise it if small, real objects are removed; lower it if floating clumps survive.

## Min occupied neighbours
<!-- param: isolatedMinNeighbors  default: 2 -->
A sparsely filled cell is removed unless at least this many of its 26 neighbouring
cells hold points. Raise it to remove larger floating clumps; lower it to keep thin
structures.

## Max tested support
<!-- param: isolatedMaxSupport  default: 2 -->
Only cells with at most this many points are tested at all; fuller cells are surface and
always stay. Raise it to catch denser clumps of noise.

## Neighbours
<!-- param: sorK  default: 12 -->
[Statistical outlier removal](help:statistical-outlier-removal) compares each point's
mean distance to this many nearest neighbours with the whole cloud's. More neighbours
judge a wider surrounding and are slower; 8–20 suits most clouds.

## Std-dev ratio
<!-- param: sorStdRatio  default: 1.5 -->
A point goes when its mean neighbour distance is more than this many standard deviations
above the cloud's mean. Lower removes more (1.0 is strong, and bites into edges and thin
detail); higher removes only clear flyers (2.5).

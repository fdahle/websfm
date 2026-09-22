---
id: mesh
title: Build a Mesh
summary: Reconstructs a continuous screened-Poisson surface from the dense cloud and its normals.
category: Products and export
order: 100
---
Meshing turns the dense point cloud into connected triangles. Screened Poisson is
smooth and robust, but it naturally creates a closed surface and may extrapolate where
the point cloud has weak support.

## Before you run
The source must be a dense cloud with per-point normals. Clean obvious floating
clusters first, because Poisson tries to explain them as surface. Missing normals mean
the cloud must be fused again.

## Quality and octree depth
<!-- param: depth default: 8 -->
Depth is the main detail, time, and memory control. Each level can multiply work
dramatically. Use Coarse for a preview and Balanced first for real work. A depth high
relative to point count mostly creates empty detail and the modal will warn you.

## Screening weight
<!-- param: screening default: 4 -->
Higher values pull the surface more tightly toward samples; lower values favour
smoothness. Excessive screening can reproduce noise, while too little can round edges
and erase small features.

## Fill gaps and trim
**Fill gaps** keeps Poisson's watertight result, including extrapolated boundary
geometry. Turn it off to trim triangles farther than the chosen multiple of the dense
cloud cell size. Trimming reduces unsupported caps but can open genuine holes.

## Colour
Colour transfer assigns each mesh vertex the colour of its nearest dense point. It is
useful for viewing, but is not a texture atlas; close inspection may show blurred or
stretched colour where mesh vertices are sparse.

## Export choice
OBJ preserves vertex colour only in applications that support the extension; STL is
geometry-only. Check the target application's axis, units, and colour support before
choosing a format.

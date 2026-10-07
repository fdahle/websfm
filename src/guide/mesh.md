---
id: mesh
title: Build a Mesh
summary: Reconstructs a continuous screened-Poisson surface from a dense cloud and its normals, then trims it to the surface the points support.
category: Products and export
order: 100
---
Meshing turns a dense point cloud into connected triangles. Screened Poisson is
smooth and robust, but on its own it produces a closed surface that extrapolates
past the data and wraps small specks of noise in their own shells. Build Mesh
therefore trims the result to what the points support, closes small holes, and
drops floating pieces. These steps are on by default.

## Before you run
The source must be a dense cloud with per-point normals. Missing normals mean the
cloud must be fused again. **Source** chooses which cloud to mesh: the cloud
selected in the 3D view if it is a dense cloud, otherwise your most recent edited
copy (a crop, filter or selection cleanup), otherwise the fused cloud. Edits are
non-destructive, so clean the cloud first (crop to the object, filter or select
away clutter) and mesh the cleaned copy.

Points far outside the bulk of the cloud are left out of the solve automatically,
so a few stray points no longer coarsen the whole mesh.

## Quality and octree depth
<!-- param: depth default: 8 -->
Depth is the main detail, time, and memory control. Each level roughly quadruples
the work. Use Coarse for a preview and Balanced first for real work. If the
cloud is too sparse for the depth you choose, the depth is lowered automatically
and the log says why. A depth that is high relative to the point count mostly
creates empty detail, and the modal warns you.

## Surface trimming
<!-- param: trim default: gentle -->
**Gentle** removes surface that no points support: the hull Poisson extrapolates
past the data, and the shells around stray specks. **Strong** also removes thinly
observed surface, which can open holes where coverage is sparse. **Off** keeps the
whole closed Poisson surface, which is useful when you need a watertight solid and
accept invented geometry where nothing was seen.

## Fill small holes
<!-- param: fillHoles default: true -->
Closes small holes that trimming opened inside otherwise solid surface. A hole is
filled only when it is closed all round and small compared with the surface
around it, so the open edges of a scan are never closed.

## Remove floating pieces
<!-- param: removeFloaters default: true -->
Drops disconnected pieces that explain only a few of the cloud's points: specks of
fusion noise and leftover clutter. The size threshold (Advanced, default 1 % of the
main surface's support) is measured in points explained, not in area. If a real
separate object disappears, lower the threshold or switch this off. If clutter
remains, it is supported by many points; remove it from the cloud instead.

## Screening weight
<!-- param: screening default: 4 -->
Higher values pull the surface more tightly toward samples; lower values favour
smoothness. Excessive screening can reproduce noise, while too little can round edges
and erase small features.

## Distance trim
<!-- param: distanceTrim default: 0 -->
An optional extra trim: triangles farther than this many sample spacings from any
point are cut. Surface trimming already covers most cases. Use this only to cut
smooth extrapolated sheets that Gentle keeps.

## Colour
Colour transfer assigns each mesh vertex the colour of its nearest dense point. It is
useful for viewing, but is not a texture atlas; close inspection may show blurred or
stretched colour where mesh vertices are sparse.

## Export choice
OBJ preserves vertex colour only in applications that support the extension; STL is
geometry-only. Check the target application's axis, units, and colour support before
choosing a format.

---
id: mesh
title: Build Mesh
summary: Reconstructs a continuous screened-Poisson surface from a dense cloud and its normals, then trims it to the surface the points support.
category: Products and export
order: 100
---
Meshing turns a dense cloud into connected triangles with screened Poisson. On its own,
Poisson closes the surface past the data and wraps noise in small shells, so Build Mesh
also trims to what the points support, closes small holes and drops floating pieces.

## Before you run
The source must be a dense cloud with normals. **Source** takes the cloud selected in
the 3D view, else your latest edited copy, else the fused cloud: clean the cloud first
(crop, filter, select) and mesh the clean copy. Far outliers are left out
automatically.

## Quality and octree depth
<!-- param: depth default: 8 -->
The octree depth of the Poisson solve: the main control of detail, time and memory,
each level about four times the work. Use Coarse for a preview and Balanced for real
work. A depth too high for the point count only adds empty detail; it is lowered
automatically when the cloud is too sparse. A solve too large for memory stops with a
message: lower the quality or set a Region.

## Screening weight
<!-- param: screening default: 4 -->
Higher pulls the surface tighter to the points; lower favours smoothness. Too much
reproduces noise, too little rounds edges.

## Tiles
<!-- param: tiles default: Auto -->
A scene too large to solve at once is solved in overlapping tiles on several workers
and welded at the seams, without cracks in continuous surface. Where a hole crosses a
seam, short open edges can remain; the log counts them. **Off** always solves in one
piece.

## Surface trimming
<!-- param: trim default: Gentle -->
**Gentle** removes surface no points support: the hull Poisson extrapolates and shells
around stray specks. **Strong** also removes thinly observed surface, which can open
holes. **Off** keeps the closed surface, for a watertight solid with invented geometry
where nothing was seen.

## Distance trim
<!-- param: distanceTrim default: 0 -->
Optionally cuts triangles farther than this many point spacings from any point. Use it
only for smooth extrapolated sheets that Gentle keeps.

## Fill small holes
<!-- param: fillHoles default: true -->
Closes small holes that trimming opened inside solid surface. The open edges of a scan
are never closed.

## Remove floating pieces
<!-- param: removeFloaters default: true -->
Drops disconnected pieces supported by few points: fusion noise and clutter. If a real
separate object disappears, lower **Floating piece size** or turn this off; clutter
that stays is well supported, so remove it from the cloud.

## Floating piece size
<!-- param: minPiecePct default: 1 % -->
A piece is dropped when fewer points lie on it than this share of the best-supported
piece. Raise it for larger clutter; lower it when a thin real object disappears.

## Transfer colour from the dense cloud
<!-- param: colorize default: on -->
Colours each vertex from the nearest dense point: fine for viewing, blurred where
vertices are sparse. For the photos' full detail, [texture the mesh](guide:texture-mesh).
Turn it off for geometry-only uses such as STL.

## Replace the main mesh
<!-- param: replaceMain default: Off -->
Off, the new mesh is added beside the others ("Mesh 2") and becomes the
[main mesh](help:main-product). On, it takes the main mesh's place and name; edited and
imported meshes are never replaced. Products built on the old mesh are kept and marked
outdated.

## Export choice
GLB and OBJ keep a texture ([Texture Mesh](guide:texture-mesh)); OBJ vertex colour
works only where the application supports it; STL is geometry only. Check the target
application's axes and units.

## Cleaning, simplifying and measuring
**Tools ▸ Mesh ▾** works on any mesh, built or imported, and adds a new mesh each time.
Clean, Smooth and Decimate are also [Workflow Builder](guide:workflow-builder) blocks.
- **Clean mesh…** welds duplicate vertices (needed for STL imports), removes small
  pieces and long bridging triangles, fills holes up to a size and drops unused
  vertices. **Close all holes** makes it watertight for printing or volume; not for
  terrain, whose outer rim would be closed too ([Clean Mesh](guide:clean-mesh)).
- **Smooth…** removes small noise without shrinking ([Smooth Mesh](guide:smooth-mesh)).
- **Decimate…** reduces the triangle count, keeping detail where the surface bends and
  preserving boundaries ([Decimate Mesh](guide:decimate-mesh)).
- **Crop…** keeps triangles inside a box ([Crop](guide:crop-cloud)).
- **Sample to points…** turns the surface into a dense cloud, for the point-cloud tools
  and DEMs ([Sample Mesh to Points](guide:sample-mesh)).
- **Texture…** paints the mesh with the photos ([Texture Mesh](guide:texture-mesh)).
- **Mesh area & volume…** (in **Tools ▸ Measure ▾**) reports the area and, for a closed
  mesh, the volume; an open mesh reports its open edges instead.

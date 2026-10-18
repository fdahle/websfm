---
id: point-cloud-tools
title: Point Cloud Tools
summary: Clean, cut, transform, align and compare dense point clouds — every tool adds a new cloud and leaves the original untouched.
category: Products and export
order: 65
---
The **Tools → Point Cloud ▾** menu collects every tool that works on a dense cloud
(computed or imported). A tool whose prerequisites are missing stays in the menu,
greyed, with the reason next to it.

Every tool is **non-destructive**: it adds a new cloud named after its source
(for example *Dense cloud (aligned)*) and hides the source, which stays one visibility
toggle away in the sidebar. Sparse clouds are not editable here: their points carry the
camera observations the later stages read. Use
[gradual selection](guide:sparse-reconstruction) for those.

Filter, Estimate normals and Align to reference (ICP) are also
[Workflow Builder](guide:workflow-builder) blocks, so a cleanup chain can be replayed
on every new run; each block works on the previous block's result.

Lengths you type are in the cloud's own coordinates: model units for a computed cloud
(metres follow from the project's scale or georeference) and the file's units for an
imported one. The dialogs show what that means for the current project.

## Clean
- **Filter…** chains height/brightness range, voxel thinning, isolated-cluster removal
  and statistical outlier removal, in that order.
- **Remove outliers…** and **Subsample…** open the same dialog with only that step on.
- **Select (rectangle)** and **Select (lasso)** switch to the 3D view with that tool,
  for hand cleanup (see [Build the Dense Cloud](guide:dense-cloud)). The row shows
  which tool is on; choosing it again turns it off.

## Edit
- **Crop…** keeps (or removes) an axis-aligned box.
- **Transform…** moves, rotates and scales the cloud, or applies a 4×4 (or 3×4)
  matrix pasted from another program. Rotation is about fixed world axes, X then Y
  then Z, around the cloud's centre or the origin. Positions stay in double precision,
  so survey coordinates are not rounded.

## Combine
- **Merge…** concatenates clouds, optionally de-duplicating the seam.
- **Align by point pairs** opens a toolbox over the 3D view. Choose the cloud to
  move and the reference, then click a point in the cloud to move (orange) and the same
  feature in the reference (blue), at least three times, well spread. The fit and its
  RMS update live; tick **Also fit scale** for clouds from different scale sources.
  **Apply** adds the aligned copy.
- **Align to reference (ICP)…** refines an alignment automatically. It only refines:
  the clouds must already overlap within the **search radius**, so align roughly first
  (point pairs, Transform or georeferencing). With a reference that has normals (a
  mesh, or a cloud after *Estimate normals*) it uses point-to-plane matching, which
  needs far fewer iterations than point-to-point: a few tens on a dense photogrammetry
  cloud, against a hundred or more. Against a mesh each point is paired with the
  closest point on its surface, not with a vertex, so a coarse mesh still aligns to the
  cloud's noise level. It stops when the cloud no longer moves, or after 100
  iterations; the log reports the RMS, the rotation and the shift, and warns when the
  limit was reached first.

## Measure
These are in **Tools → Measure ▾**, with the raster and mesh measurements.
- **Measure in 3D** measures directly in the 3D view. Choose **Distance** (two
  points), **Polyline** or **Area**, then click on a cloud or a mesh: on a mesh the
  point lands exactly where you click on the surface, on a cloud it snaps to the
  nearest drawn point. **Enter** or a double click finishes a polyline or area,
  **Backspace** removes the last point and **Esc** clears, then exits. A length is split
  into its horizontal part and its height change along the scene's up direction. An
  area gives both the **surface area** of the outline (a wall has a large one) and
  its **footprint** seen from above (near zero for a wall); the toolbox says when the
  points are far from lying in one plane. Results are in metres once the project has
  a georeference or scale bars, otherwise in model units, and in the file's own units
  on an imported layer. **Save** keeps a measurement with the project; saved ones are
  drawn while the tool is open and listed in its toolbox, whose **Export…** writes
  them as CSV or GeoJSON (see [Build a DEM ▸ Export measurements](guide:dem)).
  **Export ▸ Measurements…** writes them together with the raster measurements.
- **Distance to reference…** gives every point its distance to another cloud (to its
  nearest point) or to a mesh (exactly, to the surface). With a mesh, or a reference
  cloud with normals, the distance is **signed**: positive above the reference,
  negative below. The result opens coloured blue → white → red around zero, which is
  change detection between two aligned epochs. Points beyond **Ignore beyond** get no
  value and show grey. The distance is kept as a point attribute and saved with the
  project, so the symbology dialog can recolour it, and PLY and LAS exports carry it
  (see *Exporting attributes* below).
- **Section…** cuts a vertical slice along a line A→B, a few point spacings thick by
  default, adds it as a cloud and downloads it as a profile: CSV (distance along the
  line, height, offset, original X/Y) or DXF points for CAD.

## Attributes
- **Estimate normals…** fits a local plane to each point's neighbours. Imported clouds
  usually arrive without normals, and [meshing](guide:mesh) needs them. *Automatic*
  points the normals towards the cameras for a computed cloud and upwards for an
  imported one.
- **Classify ground…** labels each point as ground, above ground or low noise with a
  cloth simulation, so **Build DEM ▸ Points ▸ Ground only** can make a bare-earth
  terrain model. The result opens coloured by class. See [Classify
  Ground](guide:classify-ground).

## Exporting attributes
**Export ▸ Point Cloud** writes a cloud's point attributes along with its coordinates
and colours: a computed distance or ground classification, and whatever an imported
file brought (intensity, classification, GPS time, PLY scalar fields).
- **PLY** stores each attribute as a vertex property of its own type (a distance is a
  `float`). CloudCompare, MeshLab and PDAL read them as scalar fields.
- **LAS** writes intensity, classification, return numbers, scan angle, user data and
  point source ID into the standard fields when every value fits, and switches to
  point format 3 for a GPS time. Anything else (a distance, a class number above 31,
  a fractional intensity) is written as an *extra bytes* field under its own name,
  which PDAL, CloudCompare and LAStools read. Programs that don't support extra bytes
  ignore those fields.
- **LAZ** holds the same records as LAS, compressed, so the standard fields and the
  extra bytes fields both come through.
- **XYZ** has coordinates and colour only.

A **voxel downsample** in the export dialog keeps one real point per cell, with its
own colour and attribute values. Averaging would give class numbers and timestamps
that no point had. Without attributes the cell average is written, as before.

Cloud and mesh files are written in the background and streamed into the download,
so the app stays responsive and size is not limited by the format: an ASCII PLY or
XYZ of tens of millions of points works the same as a binary one, only larger.
Importing works the same way: XYZ, ASCII PLY and LAS files are read in pieces, so a
multi-gigabyte text cloud does not have to fit in memory as text. Its points do: the
browser holds at most about 89 million points of a PLY or XYZ at full precision (it caps
one buffer at 2 GiB), so import a larger cloud as LAS or LAZ, which streams (below). A LAS field that is
zero for every point (no intensity, never classified, no GPS time), or return numbers that
are all "1 of 1", is not kept, so it takes no memory and is not offered for styling.
Exporting writes the same value back, as the file had.
**Export ▸ 3D Tiles…** as a single tile takes at most the same 89 million points; a
larger cloud is written as a hierarchy of tiles from its level-of-detail octree (see
[Export 3D Tiles](guide:export-3d-tiles)).

## Very large LAS and LAZ files
A LAS or LAZ file too large to hold in memory (from about 10 million points) is
**streamed** instead: it is read a million points at a time straight into a
[level-of-detail](help:level-of-detail) octree in the project, and never held whole.
A 200-million-point LAZ takes a few minutes and 16 to 20 bytes per point of project
storage. The import dialog is skipped, since its unit and axis options would need every
point in memory; LAS surveys are in their own coordinates already.

If the file's header gives a wrong extent, the log says how many points lie outside
it: they are kept, but the view and box reads (crop, DEM) can miss them, so fix the
header and import again.

A streamed cloud is marked **streamed** in the sidebar. It keeps positions, colour,
intensity, classification and the return number and count; a file without colour
starts coloured by height. It is drawn like any big cloud, and you can style and
measure on it. Tools read it from its octree:

- **Build DEM** grids it, also as a DTM of its ground class (see
  [Build DEM ▸ Memory](guide:dem)).
- **Crop** copies the points inside the box into a new, ordinary cloud that every
  tool can use (normals, mesh, alignment, distances). Past 25 million points the copy
  is thinned evenly, so crop a smaller box for full detail. With **Keep outside the
  box**, the rest goes into a new streamed cloud instead, at full detail.
- **Select** (rectangle or lasso) works on it too. The count shows the points drawn
  at the moment; Delete, Keep only and Assign class take every point inside the shape,
  at full detail, into a new streamed cloud (a selection of an edited one refines it).
- **Filter** and **Classify ground** run tile by tile: each tile is read at full
  detail with a margin around it, so points near a tile's edge still see their
  neighbours, and the result is a new streamed cloud. Tiles are sized from where the
  points are (the octree's node counts), so a corridor or a survey with far outliers
  gets small tiles over its points and no crowded ones. The filter's margin holds what
  every chosen filter looks at (its voxel, two isolated-filter cells, the outlier
  filter's neighbour reach), and an automatic cell size is the whole cloud's, so where
  the tile edges fall does not change the result. The ground filter's margin is 40
  times the cloth resolution (at least 30 m). The outlier filter reads the cloud twice:
  first for the whole cloud's neighbour-distance statistics, then to filter every tile
  against them. A place too dense to read as one tile stops the run with a message
  rather than writing a thinned result; crop that part out first.
- **Export** writes LAS, LAZ, PLY or XYZ node by node. LAS and LAZ keep the file's own
  coordinate quantisation and its projection records; the points come in a different
  order than in the source file. **Export ▸ 3D Tiles…** writes one tile per octree
  node, placed in the CRS the file names (see [Export 3D Tiles](guide:export-3d-tiles)).

Other edits (normals, transform, alignment, distances, merge) work on a crop of it.

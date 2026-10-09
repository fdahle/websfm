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

Lengths you type are in the cloud's own coordinates: model units for a computed cloud
(metres follow from the project's scale or georeference) and the file's units for an
imported one. The dialogs show what that means for the current project.

## Clean
- **Filter…** chains height/brightness range, voxel thinning, isolated-cluster removal
  and statistical outlier removal, in that order.
- **Remove outliers…** and **Subsample…** open the same dialog with only that step on.
- **Select points** switches to the 3D view with the lasso, for hand cleanup (see
  [Build the Dense Cloud](guide:dense-cloud)).

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
  converges in a few iterations. The log reports the RMS, the rotation and the shift.

## Analyse
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

## Exporting attributes
**Export ▸ Point Cloud** writes a cloud's point attributes along with its coordinates
and colours: a computed distance, and whatever an imported file brought (intensity,
classification, GPS time, PLY scalar fields).
- **PLY** stores each attribute as a vertex property of its own type (a distance is a
  `float`). CloudCompare, MeshLab and PDAL read them as scalar fields.
- **LAS** writes intensity, classification, return numbers, scan angle, user data and
  point source ID into the standard fields when every value fits, and switches to
  point format 3 for a GPS time. Anything else (a distance, a class number above 31,
  a fractional intensity) is written as an *extra bytes* field under its own name,
  which PDAL, CloudCompare and LAStools read. Programs that don't support extra bytes
  ignore those fields.
- **LAZ** keeps the standard fields only. Extra-bytes attributes are left out and the
  log says which ones, so export LAS or PLY to keep a distance.
- **XYZ** has coordinates and colour only.

A **voxel downsample** in the export dialog keeps one real point per cell, with its
own colour and attribute values. Averaging would give class numbers and timestamps
that no point had. Without attributes the cell average is written, as before.

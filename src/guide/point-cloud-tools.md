---
id: point-cloud-tools
title: Point Cloud Tools
summary: Clean, cut, transform, align and compare dense point clouds — every tool adds a new cloud and leaves the original untouched.
category: Products and export
order: 65
---
**Tools ▸ Point Cloud ▾** holds the tools for dense clouds, computed or imported. A tool
that cannot run yet stays greyed with the reason.

Every tool adds a new cloud named after its source and hides the source, which stays
in the sidebar. Sparse clouds are edited with
[gradual selection](guide:sparse-reconstruction) instead. Filter, Estimate normals
and Align to reference (ICP) are also [Workflow Builder](guide:workflow-builder)
blocks. Lengths you type are in the cloud's own units; the dialogs say what that means.

## Clean
- **Filter…** chains height/brightness range, voxel thinning, isolated-cluster removal
  and statistical outlier removal. **Remove outliers…** and **Subsample…** open it with
  one step on.
- **Select (rectangle)** and **Select (lasso)** clean by hand in the 3D view (see
  [Build the Dense Cloud](guide:dense-cloud)).

## Edit
- **Crop…** keeps or removes an axis-aligned box.
- **Transform…** moves, rotates and scales the cloud, or applies a 4×4 matrix pasted
  from another program, in double precision.

## Combine
- **Merge…** joins clouds; a **Dedupe cell** keeps only the first cloud's points where
  they overlap.
- **Align by point pairs** aligns two clouds from at least three matching points you
  click in each, with the RMS shown live; **Also fit scale** for different scales.
- **Align to reference (ICP)…** refines an alignment that is already roughly right,
  within the **search radius**, by point-to-plane [ICP](help:icp), against a cloud or a
  mesh. The log reports the RMS, rotation and shift.

## Measure
In **Tools ▸ Measure ▾**:
- **Measure in 3D**: **Distance**, **Polyline** or **Area** by clicking on a cloud or
  mesh. Lengths are split into horizontal and height parts; an area gives its surface
  and its footprint. **Save** keeps a measurement; **Export…** writes them as CSV or
  GeoJSON.
- **Distance to reference…** gives every point its distance to another cloud or a mesh,
  signed where the reference has normals, coloured blue → red for change detection.
  The distance is kept as an attribute and exported with the cloud.
- **Section…** cuts a vertical slice along a line and exports it as a CSV profile or
  DXF.

## Attributes
- **Estimate normals…** for clouds without them; [meshing](guide:mesh) needs normals.
- **Classify ground…** labels ground and non-ground points for a terrain model (see
  [Classify Ground](guide:classify-ground)).

## Exporting attributes
**Export ▸ Point Cloud** writes attributes with the points: computed distances and
classes, and whatever an imported file brought. **PLY** stores each as a vertex
property; **LAS/LAZ** use the standard fields where they fit and *extra bytes*
otherwise; **XYZ** has coordinates and colour only. A voxel downsample keeps one real
point per cell, so classes and timestamps stay real values. Exports and imports stream,
so file size is not limited by memory; a cloud held in memory can have up to several
hundred million points.

## Very large LAS and LAZ files
A LAS or LAZ file too large for memory (from about 10 million points) is **streamed**
into a [level-of-detail](help:level-of-detail) octree in the project, a few minutes
for 200 million points. It is marked **streamed** and can be drawn, styled and
measured. Build DEM, Crop, Select, Filter, Classify ground, Transform, Export and ICP
all work on it, tile by tile or from the octree, and write new streamed clouds; other
tools work on a crop of it. A wrong header extent is reported in the log.

## COPC files
A [COPC](help:copc) file (`.copc.laz`) is already an octree, so a large one is copied
into the project as it is and drawn straight away, in about the time of the copy. It
works like a streamed cloud; edits write new clouds and the file itself never changes.
Its CRS is shown and kept in LAS/LAZ exports.

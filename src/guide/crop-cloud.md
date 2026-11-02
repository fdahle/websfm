---
id: crop-cloud
title: Crop Cloud or Mesh
summary: Keep the part of a dense cloud or mesh inside an axis-aligned box, or remove it, into a new cloud or mesh.
category: Tools
order: 121
---
**Tools ▸ Point Cloud ▾ ▸ Crop…** (and **Tools ▸ Mesh ▾ ▸ Crop…**) keeps the points or
triangles inside a box along the cloud's own axes and adds them as a new cloud or mesh.
Use it to cut a site down to the area of interest before meshing, a DEM or an export.
For a box in any orientation that also bounds the dense steps, set a
[Region](guide:model-tools) instead. Sparse models are not cropped: later steps read
their tracks.

## Box
<!-- param: box  default: the source's extent -->
The minimum and maximum X, Y and Z, in the cloud's coordinates; a field left empty
leaves that side open. **Use full extent** fills in the source's extent, a good start
to pull in from.

## Keep outside
<!-- param: invert  default: Off -->
Keeps everything outside the box and removes the inside: for cutting out a crane, a
vehicle or a person standing in the scene.

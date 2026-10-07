---
id: mesh
title: Mesh
aliases: meshes, triangle mesh, surface reconstruction, poisson reconstruction, screened poisson
summary: A connected triangulated surface fitted through the dense cloud — the step from a scatter of points to a watertight, renderable object.
---
A **mesh** turns the dense [point cloud](help:point-cloud) into an actual
surface: vertices joined into triangles, with a defined inside and outside. Points
alone cannot be shaded, textured, sectioned, or measured for volume; a mesh can.

WebSfM uses **screened Poisson surface reconstruction**, which reframes surface
fitting as solving a partial differential equation. The oriented points — position
plus normal — are treated as samples of the gradient of an indicator function
that is 1 inside the object and 0 outside; solving for that function over an
octree and extracting an isosurface yields the mesh. The "screened" variant adds
a term pulling the surface through the input points themselves, so it stays
faithful to the data rather than merely smooth.

**Normals are required, and they come for free here.** Poisson reconstruction
needs a normal per point, which normally means a separate estimation pass with
its own orientation ambiguity. WebSfM instead reuses the surface normals that
[PatchMatch](help:patchmatch) already fitted per pixel — they are consistently
oriented toward the camera that saw them by construction.

<!-- TODO(image): assets/poisson-mesh.svg - oriented input points with normal arrows, the octree subdivision around the surface, the extracted isosurface, and the same mesh after trimming - with the untrimmed version showing the balloon-like closure over an unsampled region. -->

Poisson always produces a *closed* surface that is defined everywhere. It will
balloon a smooth hull across regions nothing observed, and it wraps every small
speck of fusion noise in its own shell. Four details keep the result honest:

- **Iso level.** The surface is extracted at the average of the solution at the
  input samples (weighted by how many points each sample stands for), not at the
  naive zero level.
- **Support trimming.** Each sample carries how many dense points it represents.
  Surface whose support falls below a fraction of the typical sample's is removed:
  the extrapolated hull and the shells around specks.
- **Hole refill.** A small, closed region the trim opened inside otherwise solid
  surface is a hole the solve rightly bridged, so it is put back.
- **Floating pieces.** Disconnected pieces that explain only a sliver of the
  cloud's points are dropped. They are judged by the points they explain, not by
  their area, because Poisson inflates a tiny speck into a sizeable ball.

The main tunable is **octree depth**: each extra level halves the cell size,
capturing finer detail at roughly four times the work on a surface. It is lowered
automatically when the cloud is too sparse to use it. Vertex colour is transferred
from the nearest dense voxel cell, and the result exports as PLY or GLB.

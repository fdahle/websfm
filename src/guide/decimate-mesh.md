---
id: decimate-mesh
title: Decimate Mesh
summary: Reduce a mesh to fewer triangles while keeping its shape (quadric edge collapse), into a new mesh.
category: Tools
order: 132
---
**Tools ▸ Mesh ▾ ▸ Decimate…** removes triangles where the surface is flat and keeps
them where it bends, by [edge collapse](help:mesh-decimation). A new mesh is added. Use
it to make a mesh light enough to share, view on the web or load into CAD.

## Reduce to
<!-- param: targetMode  default: Share -->
**Share** keeps a fraction of the source's triangles; **Triangle count** reduces to a
fixed number, for a target such as a web viewer's limit.

## Share of triangles
<!-- param: targetRatio  default: 0.25 -->
The fraction of triangles kept: 0.25 keeps a quarter. Flat scenes stand 0.1 or less
without visible loss; detailed objects look worse below about 0.2.

## Triangles
<!-- param: targetTriangles  default: 200000 -->
The number of triangles to reduce to, with **Triangle count**.

## Preserve the boundary
<!-- param: preserveBoundary  default: On -->
Keeps an open surface's outline, such as a terrain edge or a cut, from being eaten
away. Turn it off only for a closed object, where there is no boundary.

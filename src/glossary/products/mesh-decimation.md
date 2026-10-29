---
id: mesh-decimation
title: Mesh Decimation
aliases: decimation, decimate, quadric edge collapse, quadric error metrics, mesh simplification
summary: Reduces a mesh's triangle count by collapsing edges where the surface is flat, keeping triangles where it bends.
refs: garland1997
---
A Poisson [mesh](help:mesh) comes out with millions of triangles, far more than a
viewer, a GLB export or a web page wants, and most of them sit on flat surface a
fraction of that count would describe just as well. **Decimation** builds a lighter
mesh of nearly the same shape.

It works by **edge collapse**: merge the two ends of an edge into one vertex, and
the two triangles that shared the edge disappear. The questions are which edges to
collapse and where to put the merged vertex. **Quadric error metrics** (Garland &
Heckbert, 1997) answer both. Every vertex remembers the planes of the triangles
around it, stored as a small matrix $Q$ that gives the sum of squared distances from
any point to those planes:

$$\text{error}(v) = \sum_{p} (p^{\top} v)^2 = v^{\top} Q\, v$$

Collapsing an edge adds the two ends' matrices, puts the merged vertex where that
sum is smallest, and costs that smallest sum. On flat ground all the planes agree and
a collapse costs almost nothing; across a ridge or a corner it costs a lot. Taking
the cheapest edges first therefore removes triangles from flat areas and keeps them
where the surface bends.

<!-- TODO(image): assets/mesh-decimation.svg - one edge before and after collapse, the two removed triangles shaded, the planes of the surrounding faces drawn; next to it a terrain mesh decimated to a quarter, with large triangles on flat ground and small ones along a ridge. -->

In WebSfM, **Tools ▸ Mesh ▸ Decimate** reduces to a share of the triangles (a
quarter by default) or to a set count. A collapse that would fold a triangle over or
make an edge shared by more than two triangles is refused. **Preserve the boundary**
(on by default) makes collapses along an open edge expensive, so a terrain outline
or a cut is not eaten away. The merged vertex takes the colour interpolated along
the collapsed edge, and the result is a new mesh. See [Build a Mesh](guide:mesh).

A large mesh is decimated in **blocks**, one per worker: each block with the vertices
it shares with another block locked (never moved or removed), so the blocks still meet
when joined. The blocks stop a fifth above the target, and one last pass over the
joined mesh takes the cheapest collapses left, which include the seams the locks kept
dense. On the meshes measured this was 4× faster than one pass over the whole mesh, at
the same or a slightly smaller error.

**Export ▸ 3D Tiles** decimates too, to build the coarser levels of a
[3D Tiles](help:3d-tiles) tileset: there the vertices on a tile's border are locked,
never moved or removed, so neighbouring tiles decimated apart still meet.

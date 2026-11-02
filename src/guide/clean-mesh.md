---
id: clean-mesh
title: Clean Mesh
summary: Weld, remove small pieces and bridging triangles, fill holes and tidy a mesh, into a new mesh.
category: Tools
order: 130
---
**Tools ▸ Mesh ▾ ▸ Clean mesh…** repairs a mesh, built or imported, in the order of its
steps: weld duplicate vertices, remove small pieces, remove long bridging triangles,
fill holes, drop unused vertices. A new mesh is added; a textured mesh loses its texture
where holes are filled. Run it before measuring a volume, 3D printing, or when a mesh
shows floating fragments or webbing across gaps.

## Smaller than
<!-- param: minFraction  default: 0.01 -->
A piece is removed when it has fewer triangles than this share of the largest piece.
Raise it to remove larger floating fragments; lower it, or turn the step off, when the
scene has several separate objects of different sizes.

## Or fewer than
<!-- param: minTriangles  default: 50 -->
A piece with fewer triangles than this is removed whatever its share. Raise it for
speckle left around a large mesh.

## Longer than
<!-- param: maxEdgeFactor  default: 6 -->
Poisson meshing stretches long thin triangles across gaps in the data. A triangle with
an edge longer than this many times the median edge is removed. Lower removes more
webbing, and can open holes in sparsely covered areas.

## Close all holes
<!-- param: fillAll  default: Off -->
Closes every opening, the outer rim of an open surface included, so the mesh is
watertight: for an object to 3D-print or to measure its volume. Leave it off for
terrain, whose edge is meant to be open.

## Up to
<!-- param: maxHoleEdges  default: 64 -->
Holes ringed by at most this many edges are filled; larger openings stay. Raise it for
bigger gaps, such as under a vehicle or behind an object.

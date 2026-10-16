---
id: surface-normal
title: Surface Normal
aliases: surface normals, normals, point normals, vertex normals, normal estimation, estimate normals
summary: The direction perpendicular to a surface at a point, i.e. which way the surface faces. Meshing, point-to-plane ICP, signed distances and shading all depend on it.
---
A **surface normal** is a unit vector at right angles to the surface at a point:
the direction the surface faces. A point on a floor has a normal pointing up, a
point on a wall one pointing out of the wall. It is the cheapest description of
local shape beyond position, and several later steps cannot work without it:

- [Poisson meshing](help:mesh) reads the normals as the gradient of an
  inside/outside function. Without normals there is no mesh.
- [ICP](help:icp) in point-to-plane mode measures misalignment along the
  reference's normals.
- A signed [cloud-to-cloud distance](help:cloud-distance) needs a normal to tell
  above from below.
- The 3D view shades a mesh by how its normals face the light.

**An axis, then a side.** A point on its own has no orientation, so a normal is
estimated from the point's neighbours: fit a plane through its k nearest points, and
the normal is the direction in which that neighbourhood is thinnest (the
eigenvector of the smallest eigenvalue of their covariance, a principal component
analysis). That fixes the *axis* but not the *side*. A plane has two faces, and the
fit cannot tell which one is outward. The side has to come from outside knowledge,
such as where the camera that saw the point was standing.

<!-- TODO(image): assets/surface-normal.svg - a curved surface sampled by points, one point's k nearest neighbours circled with the fitted tangent plane, the normal axis drawn in both directions, and the camera that saw the point deciding which direction is outward. -->

A dense cloud computed in WebSfM gets its normals for free: [PatchMatch](help:patchmatch)
fits a small tilted plane at every [depth map](help:depth-map) pixel, fusion keeps
that plane's normal, and it faces the camera that saw it by construction. An
imported cloud usually arrives without normals, which is what **Tools ▸ Point Cloud
▸ Estimate normals** is for. It fits the plane over the 16 nearest neighbours by
default (more is smoother, fewer keeps sharp edges) and then turns each normal to a
reference: **towards the nearest camera** (right for walls and overhangs, and the
automatic choice for a computed cloud), **upwards** (+Z, right for terrain seen from
above, and the automatic choice for an imported cloud), or the side the cloud's
existing normals already face. The side is never propagated from neighbour to
neighbour, because one wrong step would flip a whole region. A mesh's normals follow
from its triangles: each face faces the side its corner order winds around, and a
vertex normal is the area-weighted average of the faces around it. See
[Point Cloud Tools](guide:point-cloud-tools).

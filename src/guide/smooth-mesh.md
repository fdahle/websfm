---
id: smooth-mesh
title: Smooth Mesh
summary: Smooth the noise out of a mesh without shrinking it (Taubin smoothing), into a new mesh.
category: Tools
order: 131
---
**Tools ▸ Mesh ▾ ▸ Smooth…** removes surface noise from a mesh by
[Taubin smoothing](help:mesh-smoothing): each pass smooths and then inflates by about
as much, so the mesh does not shrink as plain averaging would. A new mesh is added. Use
it on a bumpy photogrammetric surface before display or export; it also softens real
edges, so keep the passes few on buildings.

## Iterations
<!-- param: iterations  default: 10 -->
How many smooth-and-inflate passes run. Each removes finer noise; more passes also round
off real corners and edges. 5–20 suits most meshes.

## Keep the boundary fixed
<!-- param: fixBoundary  default: On -->
Keeps the outline of an open surface, such as a terrain edge or a cut, where it is.
Turn it off only for a closed object.

## λ (smooth)
<!-- param: lambda  default: 0.5 -->
How far each pass moves a vertex towards its neighbours' average. Higher smooths faster
per pass.

## μ (inflate)
<!-- param: mu  default: -0.53 -->
The inflating step after each smoothing one. It must be more negative than −λ, or the
mesh shrinks with every pass; slightly more negative (as the default) keeps the volume.

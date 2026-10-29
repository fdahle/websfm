---
id: main-product
title: Main product
aliases: main product, main dense cloud, main mesh, main DEM, main orthophoto, outdated product
summary: One product of each kind is the main one, the input the next step uses; a product built on something that has changed since is marked outdated.
---
A project can hold several dense clouds, meshes, DEMs and orthophotos: a rebuild adds a
new one beside the old ones rather than replacing it, unless the build dialog's
**Output ▸ Replace the main …** is on. One of each kind is the **main** one, marked
*main* in the sidebar once there are two. It is what the next step uses: a DEM is
built from the main dense cloud, a mesh-surface orthophoto from the main mesh, a
DEM-surface orthophoto from the main DEM. Being main only decides the input: any DEM
or orthophoto, main or not, opens in its own tab, goes on the 2D map, takes a
symbology and downloads. A new build becomes the main one and takes the place of the
one before on the map; right-click another product ▸ **Set as main** to use that one
instead. The sparse model has its main one
too, for the same reason.

A product is **outdated** when something it was built from has changed since: the
sparse model was rebuilt or edited (Optimize cameras, Gradual selection), the dense
cloud under a DEM was rebuilt in its place, or the main sparse model is now another
one. It carries an *outdated* badge, and its tooltip and **Show information** say why.
An outdated product is kept, never removed for you, and it stays on offer as the input
of a tool, named *outdated* there: comparing an old surface with a new one is a reason
to pick it. Products built on an outdated one are outdated too. An imported cloud is
built from nothing in the project, so it is never outdated.

Metashape works the same way: each chunk has a default point cloud, model, DEM and
orthomosaic, and the build dialogs ask whether to replace the default one.

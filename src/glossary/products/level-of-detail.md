---
id: level-of-detail
title: Level of Detail (point clouds)
aliases: level of detail, level-of-detail, point budget, octree
summary: Drawing a big point cloud from an octree of ever finer subsamples, so only the points the view can show are loaded and drawn.
---
A graphics card can draw a few million points smoothly, but a dense cloud or a LiDAR
survey easily has a hundred million. Most of them would land on the same screen pixel
anyway: from far away, one point in a hundred is enough to show the shape.

So WebSfM stores a big cloud as an **octree**. The cube around the cloud is split into
eight smaller cubes, those again, and so on. Every cube (a *node*) keeps a thin,
even sample of the points inside it, about one per cell of a 128 × 128 × 128 grid over
the cube, and passes the rest on to its eight children. The top node is a coarse
overview of the whole cloud; each level below doubles the detail, and every point is
in exactly one node. This is the scheme of Potree and of COPC (Cloud Optimized Point
Cloud) files.

<!-- TODO(image): assets/level-of-detail.svg - a terrain cloud as the root's sparse sample, then one quadrant refined twice, the nodes' cubes outlined. -->

While you orbit, the viewer walks the octree from the top and takes the nodes in the
view that are largest on screen first, until the **point budget** is spent (5 million
by default, Settings ▸ Map & 3D). Nodes that are not loaded yet are read from the
project's storage in the background, so the view sharpens from coarse to fine. Nodes
already loaded stay on the graphics card until it needs the room for others.

Dense clouds of 4 million points or more get their octree automatically when they are
made or imported. It is saved with the project, so it is built only once; an edit
that changes the points (a selection deleted or reclassified) builds it again. A LAS or LAZ
file too large to hold in memory goes straight into an octree as it is read: a
*streamed* cloud, whose points exist only there (see
[Point Cloud Tools](guide:point-cloud-tools)).

---
id: 3d-tiles
title: 3D Tiles
aliases: 3D Tiles, Cesium 3D Tiles, tileset, geometric error, screen-space error
summary: The open format for streaming large 3D models onto a globe: a tree of tiles, each a coarser or finer piece of the model, loaded only where the camera needs it.
---
**3D Tiles** is the Open Geospatial Consortium's format for 3D content on a web globe,
read by CesiumJS, Cesium for Unreal and Unity, ArcGIS, deck.gl and others. A
*tileset* is a `tileset.json` describing a tree of *tiles*. Each tile has a bounding
box, optional content (here a glTF model: points or triangles) and children that
describe the same space in more detail.

<!-- TODO(image): assets/3d-tiles.svg - a quadtree of terrain tiles, the coarse root over the whole area and finer tiles only near the camera, with each tile's geometric error projected to pixels. -->

Every tile states its **geometric error**: how far, in metres, drawing this tile
without its children stands from the full detail. The viewer projects that length onto
the screen at the tile's distance, the **screen-space error**, and loads the children
once it exceeds a threshold of a few pixels. Far away a coarse tile is enough; up close
the viewer descends to the finest tiles, but only for the part of the model in view.
So the model opens at once whatever its size, and memory and download follow what is
on screen.

A tile's children either *replace* it (a mesh: a finer surface instead of the coarse
one) or *add* to it (a point cloud: more points between the coarse ones). The tileset's
root carries the transform that places its local coordinates on the Earth
(earth-centred, earth-fixed metres), so the tiles themselves can keep small numbers.

In WebSfM, **Export ▸ 3D Tiles…** writes a point cloud from its
[level-of-detail](help:level-of-detail) octree, or a mesh split into tiles and
[decimated](help:mesh-decimation) per level. See
[Export 3D Tiles](guide:export-3d-tiles).

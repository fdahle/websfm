---
id: export-3d-tiles
title: Export 3D Tiles
summary: Put a point cloud or a mesh on a globe in CesiumJS and other 3D Tiles viewers, as one tile or as a tileset that streams in level by level.
category: Products and export
order: 107
---
**Export ▸ 3D Tiles** writes the selected mesh, or else the selected point cloud, as
[3D Tiles](help:3d-tiles) 1.1: a `tileset.json` and glTF tiles, in one .zip. Unzip it
on a web server and point a viewer at the `tileset.json`, for example CesiumJS:
`Cesium.Cesium3DTileset.fromUrl('…/tileset.json')`.

The model is placed on the globe by the project's [georeference](help:georeferencing):
its coordinates are kept in the project CRS around a point in the middle of the model,
and the tileset's transform takes them to the globe. That transform is measured from
the CRS itself, so the model lands correctly even where a map projection's grid is not
aligned with north (near the poles). Without a georeference the tileset has no place
on the globe: it is written in model units around its centre.

A **streamed** cloud (a LAS or LAZ too large for memory, see
[Point Cloud Tools](guide:point-cloud-tools)) is written in its own coordinates, as its
LAS export is, and placed in the CRS its file names, else in the project CRS.

## Tiling
<!-- param: tiling  default: Level of detail from 1 million points or 250,000 triangles, else Single tile -->
**Single tile** writes the whole model as one glTF file. A viewer has to load all of it
before it shows anything, which is fine for a few hundred thousand points or
triangles. One tile holds at most about 89 million points (the browser caps one buffer
at 2 GiB), so a larger or streamed cloud is always tiled.

**Level of detail** writes a hierarchy of tiles. A viewer loads the coarse top tiles
first and the finer ones only where the camera is close, so a model of any size opens
at once and stays smooth. Each tile carries a *geometric error*, the size of the detail
it leaves out, and the viewer refines a tile once that error covers more than a few
pixels on screen (16 by default in CesiumJS, its `maximumScreenSpaceError`).

- A **point cloud** is tiled by its [level-of-detail](help:level-of-detail) octree, one
  tile per node. Each node holds an even sample of its cube and passes the rest to its
  children, so the tiles *add* up: the finer tiles add points between the coarse ones.
  A tile's error is its point spacing. Colour, classification and intensity are kept;
  the last two as glTF metadata (properties `classification` and `intensity`) that a
  viewer can style by, as a CesiumJS `Cesium3DTileStyle` can.
  A cloud with an octree is read from it node by node, so the export takes little
  memory however large the cloud is. Turn on point attenuation in the viewer
  (`tileset.pointCloudShading.attenuation = true`) to close the gaps between points of
  the coarser tiles.
- A **mesh** is split in space, as a quadtree for terrain or an octree for an object,
  until every piece fits in a tile (see **Triangles per tile**). Those pieces are the
  finest tiles, the mesh itself. Each coarser tile is its children joined and
  [decimated](help:mesh-decimation) back to one tile's size, and it *replaces* them
  when the viewer is far away. The vertices along a tile's border are never moved or
  removed by that decimation, so neighbouring tiles always meet, whichever level each
  is drawn at. A tile's error is the larger of how far its surface may stand from the
  mesh and the length of its triangles' edges.

A textured mesh keeps its texture in the finest tiles: the atlas pages are written once
next to the tiles, and each tile names the pages it uses. The coarser tiles are drawn
with vertex colours, since a decimated surface cannot follow the photos' texture
coordinates.

## Triangles per tile
<!-- param: tileTriangles  default: 65,536 -->
How many triangles a mesh tile holds, with **Tiling ▸ Level of detail**: the finest
tiles at most this many, the coarser ones about this many after decimation (a little
more where many border vertices are kept). 65,536 triangles make a tile of 1 to 2 MB.
Fewer triangles make more, smaller tiles, which load in finer steps; more make fewer
requests. Point-cloud tiles are sized by the octree instead.

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

The project's [georeference](help:georeferencing) places the model on the globe,
correctly even near the poles. Without one, the tileset is written in model units and
has no place on the globe. A streamed cloud ([Point Cloud Tools](guide:point-cloud-tools))
is placed in the CRS its file names.

## Tiling
<!-- param: tiling  default: Level of detail from 1 million points or 250,000 triangles, else Single tile -->
**Single tile** writes one glTF file the viewer loads whole: fine for a few hundred
thousand points or triangles. Clouds over about 89 million points are always tiled.

**Level of detail** writes a hierarchy: the viewer loads coarse tiles first and finer
ones only up close, so a model of any size opens at once.
- A **point cloud** is tiled by its [level-of-detail](help:level-of-detail) octree;
  finer tiles add points between coarse ones. Classification and intensity are kept as
  metadata for styling. Turn on point attenuation in the viewer to close gaps.
- A **mesh** is split into tiles, and coarser tiles are
  [decimated](help:mesh-decimation) joins of their children, with borders kept so
  neighbours always meet. A textured mesh keeps its texture in the finest tiles; coarser
  ones use vertex colours.

## Triangles per tile
<!-- param: tileTriangles  default: 65,536 -->
How many triangles a mesh tile holds with **Level of detail** (65,536 ≈ 1–2 MB). Fewer
make more, smaller tiles that load in finer steps; more make fewer requests.

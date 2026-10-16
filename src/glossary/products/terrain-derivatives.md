---
id: terrain-derivatives
title: Terrain Derivatives
aliases: terrain derivative, hillshade, hillshading, slope and aspect
summary: Slope, aspect and hillshade, rasters computed from the DEM's local height gradient. They show how steep the ground is, which way it faces, and how it looks lit by a low sun.
---
A [DEM](help:digital-elevation-model) stores height, but most questions about terrain
are about how height *changes*. Three classic rasters are derived from the local
gradient:

- **Slope**: how steep the ground is, in degrees from horizontal or in percent
  (rise / run × 100, so 45° is 100 %).
- **Aspect**: which way the ground faces downhill, in degrees clockwise from north.
  Flat ground has no aspect.
- **Hillshade**: how bright the surface would be under a sun at a given direction
  (azimuth) and height (altitude), which is the relief shading of a topographic map.
  By convention the sun comes from the north-west (315°) at 45°. With a sun from the
  south most viewers see valleys as ridges. A **multidirectional** hillshade blends
  several sun directions, so no slope facing away from the sun disappears into shadow.

All three come from one estimate of the gradient: **Horn's method**, the weighted
3×3 finite difference that GDAL's `gdaldem` uses. For each cell it compares the
heights of the columns east and west of it, and the rows north and south, counting
the nearer neighbours twice:

$$\frac{\partial z}{\partial x} = \frac{(z_{NE} + 2z_{E} + z_{SE}) - (z_{NW} + 2z_{W} + z_{SW})}{8\,\Delta x}, \qquad \text{slope} = \arctan \lVert \nabla z \rVert$$

<!-- TODO(image): assets/terrain-derivatives.svg - one small DEM tile shown four ways side by side: heights as a colour ramp, slope, aspect as a compass-coloured wheel, and a hillshade lit from the north-west, with the sun direction drawn. -->

**The units must match.** Slope compares a vertical rise with a horizontal run, so
both must be in the same unit. Metres over metres works. A DEM in degrees of
longitude and latitude does not, and WebSfM refuses it: build the DEM in a projected
[CRS](help:coordinate-reference-system) instead. In a projected CRS the grid spacing
also carries the projection's scale factor, which WebSfM corrects at the DEM centre.

In WebSfM, **Tools ▸ Products ▸ Slope, aspect, hillshade** writes each chosen raster
as a GeoTIFF on the DEM's own grid and CRS (slope in degrees and a hillshade by
default). A cell next to a hole or the edge uses its own height for the missing
neighbour, so it still gets a one-sided estimate; a nodata cell stays nodata in
every product. The hillshade drawn under a DEM on the map is a quicker preview
computed separately, not this export. See [Build a DEM](guide:dem).

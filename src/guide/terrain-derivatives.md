---
id: terrain-derivatives
title: Slope, Aspect, Hillshade
summary: Derive slope, aspect and hillshade rasters from a DEM, as GeoTIFFs.
category: Tools
order: 141
---
**Tools ▸ Products ▾ ▸ Slope, aspect, hillshade…** computes
[terrain derivatives](help:terrain-derivatives) of the main DEM and saves each as a
GeoTIFF: how steep each cell is, which way it faces, and a shaded relief for maps.

## Slope units
<!-- param: slopeUnits  default: Degrees -->
**Degrees** from 0 (flat) to 90 (vertical), or **Percent**, rise over run × 100, as road
and drainage design use it (45° is 100 %).

## Sun azimuth
<!-- param: azimuth  default: 315° -->
The compass direction the light comes from. 315° (north-west) is the cartographic
convention, which most people read as raised relief; light from the south can make
valleys look like ridges.

## Sun altitude
<!-- param: altitude  default: 45° -->
The sun's height above the horizon. Lower brings out gentle relief with long shadows;
higher gives a flatter, softer shade.

## Multidirectional
<!-- param: multidirectional  default: Off -->
Blends four sun directions, so no slope disappears into shadow: clearer in steep,
varied terrain, less dramatic on gentle ground.

## Compression
<!-- param: compression  default: DEFLATE -->
**DEFLATE** makes the GeoTIFFs smaller without losing data; **None** only for software
that cannot read compressed TIFFs.

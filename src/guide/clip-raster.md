---
id: clip-raster
title: Clip to Polygon
summary: Export the part of a DEM or orthophoto inside a polygon as a GeoTIFF, the rest set to no-data.
category: Tools
order: 142
---
**Tools ▸ Products ▾ ▸ Clip to polygon…** saves the DEM or orthophoto cut to a polygon
as a GeoTIFF: the cells outside become no-data (transparent in an orthophoto), and the
raster's extent shrinks to the polygon. Use it to deliver a site boundary, or to keep a neighbour's land out of a
delivery.

## Polygon
<!-- param: polygon  default: A saved area measurement -->
**A saved area measurement** is an Area or Volume measurement drawn on the raster and
saved. **A GeoJSON file** takes a Polygon or MultiPolygon, holes included, in the
raster's coordinates, or reprojected when the file names its CRS: a boundary from GIS.

## Compression
<!-- param: compression  default: DEFLATE -->
**DEFLATE** makes the GeoTIFF smaller without losing data; **None** only for software
that cannot read compressed TIFFs.

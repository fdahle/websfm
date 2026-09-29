---
id: dem
title: Build a DEM
summary: Rasterises a sparse or dense cloud into a gridded elevation surface.
category: Products and export
order: 80
---
A [digital elevation model](help:digital-elevation-model) collapses 3D points into
one height per grid cell. A dense cloud produces a useful DSM; the sparse tie-point
cloud is acceptable only for a coarse preview.

## Coordinate frame
<!-- param: crs default: Local -->
**Local** uses the model orientation and its best available scale. **Project CRS**
requires a georeference fit and produces real-world coordinates. For an object with
a scale bar, Local is metric but still has no CRS.

## Ground sample distance
<!-- param: gsd default: Auto -->
Cell size in metres or model units per pixel. Auto estimates a sensible value from
point density. Choosing a much finer cell than the source spacing makes a larger file,
not more detail, and forces interpolation across more empty cells.

## Surface aggregation
**Max** creates a DSM top surface, retaining roofs and vegetation. **Min** is only
“ground-ish”—it is not a classified terrain model. Median resists outliers, while
mean gives a smooth average where many points occupy a cell.

## Gap interpolation
**Inverse distance** blends nearby measured heights smoothly; **Nearest neighbour**
preserves hard steps; **None** leaves nodata. The radius never enlarges the raster—it
only fills an empty cell when measured data is close enough. Large radii can invent
surface across real gaps, especially from a sparse cloud.

## Inspect before export
Look for spikes, pits, edge extrapolation, bridges across gaps, and a plausible height
range. Export GeoTIFF when the product has a CRS; preserve nodata for downstream GIS.

## Measure a raster
Open the DEM tab and choose **Measure → Ruler / polyline**, **Planimetric area**,
or **Elevation profile**. Click vertices, then Finish; Undo point and Clear edit
the current drawing. Hold Shift while dragging to pan. A new click after Finish
starts a new measurement. Enter a name and choose **Save measurement** to keep
it with the project. The **Saved** selector reopens measurements; Rename and Delete
manage them. Saved profiles retain their sampled elevations and nodata gaps.
Rebuilding the raster or changing its coordinate frame marks older measurements
**stale**. Their saved results remain readable; draw a new measurement on the
current source to replace them.

Distance and area use the raster's recorded horizontal frame and display its
units, including model units when scale is unknown. Area is the horizontal
footprint, not terrain surface area. Measurements are unavailable for geographic
coordinates or a stale computed frame. Profiles require a loaded DEM, preserve
nodata gaps, and can be downloaded with **Export profile CSV**. The profile uses
approximately one-cell spacing, coarsened for very long paths.

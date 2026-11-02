---
id: dem
title: Build a DEM
summary: Rasterises a sparse or dense cloud into a gridded elevation surface.
category: Products and export
order: 80
---
A [digital elevation model](help:digital-elevation-model) gives one height per grid
cell. Build it from a dense cloud; the sparse cloud is enough only for a coarse preview.

## Points
<!-- param: points default: All points -->
**All points** builds a surface model (DSM), roofs and canopy included. **Ground only**
builds a terrain model (DTM) from the ground class: run
[Classify Points](guide:classify-ground) first. **Classes…** builds the top surface of
the classes you tick. The line under the field names the classified cloud it uses.
Ground only turns on Fill enclosed gaps, to close the holes under removed buildings.

## Classes
<!-- param: classes default: High vegetation -->
The classes that go into the grid with **Points ▸ Classes…**. High vegetation gives the
canopy top, Building the roofs; subtract a DTM of the same area
([DEM of difference](help:dem-of-difference)) for tree or building heights. Turn off
Fill enclosed gaps to keep the gaps between them open.

## Coordinate frame
<!-- param: crs default: Local -->
**Local** uses the model's own frame and scale, levelled from the cameras. **Project
CRS** gives real-world coordinates and needs a georeference; once there is one, it is
preselected. When it is unavailable, the option says why: the project is still in
degrees (choose a projected CRS), or there are fewer than three camera positions or
GCPs.

## Extent
<!-- param: extent default: Dense core -->
**Dense core** grids only where the cloud is dense, leaving out the thin points that
oblique photos see far off, which would make the DEM huge and mostly empty. The log
says how many points that drops. **All points** grids the whole cloud. A Region (Tools ▸
Model ▸ Region) limits both.

## Raster size by
<!-- param: sizeBy default: Cell size -->
Set the DEM's size as a **Cell size** or as the **Long side** in pixels; the other
follows from the extent. The line under the field shows the size the run will build.

## Ground sample distance
<!-- param: gsd default: Auto -->
The cell size ([ground sample distance](help:ground-sample-distance)). Auto matches
the point spacing, up to 4,096 cells a side. A finer cell than the points' spacing
adds file size, not detail. A larger grid, up to 65,535 cells a side, is built in
blocks as a [Cloud-Optimized GeoTIFF](help:cloud-optimized-geotiff) and read at full
resolution by the exports, the map, profiles, volumes and clips.

## Long side
<!-- param: longSide default: Auto -->
The number of cells on the DEM's longer side; the cell size follows. **0** (Auto) puts
about one point in each cell.

## Surface aggregation
<!-- param: aggregate default: Median -->
How the points in one cell become its height. **Median** ignores stray points above and
below. **Max** keeps roof and tree tops, but on slopes it takes each cell's highest
corner. **Mean** is smooth but pulled by outliers. **Min** takes the lowest point; it is
not a terrain model (use Points ▸ Ground only for that).

## Gap interpolation
<!-- param: fillMethod default: Inverse distance -->
How empty cells near measured ones are filled ([gap interpolation](help:gap-interpolation)).
**Inverse distance** blends nearby cells smoothly. **Nearest neighbour** keeps steps
such as roof edges sharp but looks blocky. **None** leaves them empty, showing exactly
where the cloud has no points.

## Interpolation radius
<!-- param: fillRadius default: 2 px -->
How far, in cells, an empty cell may be from a measured one and still be filled. 1–2
closes the speckle of a dense cloud; larger values bridge real gaps with invented
surface. It never grows the raster, and a coarser cell covers more ground per cell.

## Fill enclosed gaps
<!-- param: fillHoles default: Off -->
Fills every empty area surrounded by measured cells, however large (under a removed
building, a pond), with a smooth estimate. Gaps reaching the edge of the grid stay
empty. On by default for Ground only.

## Replace the main DEM
<!-- param: replaceMain default: Off -->
Off, the new DEM is added beside the others ("DEM 2") and becomes the
[main DEM](help:main-product) the next steps use. On, it takes the main DEM's place and
name. Either way, products built on the old one are kept and marked outdated.

## Support layer
<!-- param: supportExport default: — -->
Each DEM records which cells were measured and which were interpolated. **Export ▸ DEM ▸
Support layer** writes it as a GeoTIFF: per cell the percentage measured (100 =
measured, 0 = filled, 255 = empty). The Quality Report uses it to report the error of
measured and filled cells separately.

## Show on the 2D map
A new DEM goes on the 2D map, drawn as a hillshade. Its checkbox in the Products
section takes it off and puts it back, and its row has an **Opacity** slider. The
status bar shows the height under the cursor.

**View ▸ Map ▸ Layers** lists everything on the map in one stack, as in a GIS: drag rows
to restack, untick to hide, ✕ to remove, and set opacity or zoom below the list. The
basemap is always at the bottom; footprints, GCPs and cameras always on top.

**View ▸ Map ▸ Model Frame** switches the map between the **Project CRS** (basemap,
GPS, GCPs, CRS products) and the **model frame**, a top-down view of the local model
and its Local products.

## Memory
A DEM holds a copy of the cloud's points (about 24 bytes each) and its grid within the
memory budget (Settings ▸ Compute). If a build is refused, raise the budget, set a
region, thin the cloud (Tools ▸ Point Cloud ▸ Filter) or use a coarser cell size. A
streamed cloud is read only as finely as the cell size needs.

## Inspect before export
Look for spikes, pits, extrapolated edges and bridges across gaps, and check the height
range. Export a GeoTIFF when the DEM has a CRS.

## Measure a raster
With a DEM or orthophoto open, **Tools ▸ Measure ▾** offers **Ruler**, **Area**,
**Profile** and **Volume** (the last two need heights, so a DEM). Click vertices;
**Enter** finishes, **Backspace** removes the last point, **Esc** clears. On the 2D
map, **Map layer to measure** picks the raster, so you can draw over the orthophoto and
read heights from the DEM.

Name a result and **Save measurement** to keep it; **Saved measurements** lists them.
Rebuilding the raster marks older measurements stale. In a projected CRS, lengths,
areas and volumes are ground values (the projection's scale factor is divided out);
area is the horizontal footprint. An [elevation profile](help:elevation-profile) keeps
nodata gaps and exports as CSV.

## Measure a volume
**Volume** measures material inside a polygon against a **Base**:
- **Best-fit plane through vertices**, for ground that slopes around the feature;
- **Lowest vertex**, a horizontal base at the lowest vertex;
- **Custom height**, a horizontal base at a height you enter;
- **Reference DEM**, an imported DEM, which makes the result a
  [DEM of difference](help:dem-of-difference) between two epochs (**Gain** and
  **Loss**). Heights are converted between [vertical datums](help:vertical-datum)
  where both are declared;
- **Background terrain (~30 m)**, the global terrain model, for large changes only.

**Cut** is the volume above the base, **Fill** below it, **Net** their difference.
**DEM coverage** below 100 % means holes or areas off the raster were left out, so the
volume is too small: fill holes first or redraw.

## Export coordinate system
<!-- param: rasterCrs default: As built -->
**As built** writes the DEM in its own CRS. **Another CRS…** writes a reprojected
Cloud-Optimized GeoTIFF in the [CRS](help:coordinate-reference-system) you pick, at the
same cell size. Heights keep their [vertical datum](help:vertical-datum). A Local DEM
cannot be reprojected.

## Export resampling
<!-- param: resampling default: Bilinear -->
How a reprojected copy samples heights. **Bilinear** interpolates; **Nearest** keeps
every height as measured, for a DTM that must not be smoothed.

## Export measurements
<!-- param: measurementCoords default: Project CRS -->
**Export ▸ Measurements** writes the saved measurements as **CSV** (one row each, every
value with its unit, geometry as WKT) or **GeoJSON**. **Project CRS** keeps the exact
coordinates and heights and names the CRS in the file, as QGIS reads it. **WGS 84
(RFC 7946)** is the strict web standard: 2D longitude and latitude, with the original
coordinates kept per feature. Measurements without a CRS are written in their own
frame.

## Contours, slope and clipping
**Tools ▸ Products ▾** derives files from the DEM and orthophoto:
- **Contours…** traces lines at an interval (*0* picks one), adds them to the map as a
  layer and downloads them as GeoJSON or DXF. **Smooth the DEM first** and **Drop lines
  shorter than** remove the small rings that height noise makes on flat ground; set
  both to *0* for the exact trace.
- **Slope, aspect, hillshade…** writes each as a GeoTIFF on the DEM's grid (Horn's
  method, as in GDAL).
- **Clip to polygon…** exports the DEM or orthophoto cropped to a saved Area or Volume
  measurement or a GeoJSON polygon, reprojected when the file names its CRS.

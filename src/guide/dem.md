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
Open the DEM or orthophoto tab. The ribbon's contextual tab then shows a
**Measure** group: **Ruler**, **Area**, **Profile** and **Volume**. Profile and
Volume need elevations, so they appear for DEMs only. A bar at the top of the view
shows the active tool. Click vertices on the raster. **Enter** finishes,
**Backspace** removes the last point, and Shift-drag pans. **Esc** clears the
drawing, and a second Esc leaves the tool; clicking the active ribbon button also
turns it off. A click after Finish starts a new measurement.

The result card shows the value with its details (perimeter for an area, elevation
range and relief for a profile, cut/fill/coverage for a volume). Type a name and
choose **Save measurement** to keep it with the project. **Saved** in the ribbon
opens the list of this raster's saved measurements. Click one to reopen it, then
rename or delete it from its card. Rebuilding the raster or changing its coordinate
frame marks older measurements **stale**. Their saved results remain readable;
draw a new measurement on the current source to replace them.

Distance and area use the raster's recorded horizontal frame and display its
units, including model units when scale is unknown. In a projected CRS, lengths,
areas and volumes are reported as **ground** values: the map projection's scale
factor k at the raster centre (0.98 at 80°S in Antarctic Polar Stereographic) is
divided out, and the result card shows the k it used. Heights are not scaled. Area
is the horizontal footprint, not terrain surface area. Measurements are unavailable for geographic
coordinates or a stale computed frame. Profiles require a loaded DEM, preserve
nodata gaps, and can be downloaded with **Export profile CSV**. The profile uses
approximately one-cell spacing, coarsened for very long paths.

## Measure a volume
**Volume (cut / fill)** measures material inside a polygon relative to a base
surface, for example a stockpile, an excavation or a fill. Draw the polygon around
the feature's toe, then choose the **Base** in the measuring toolbox:
- **Best-fit plane through vertices**: a plane fitted to the DEM heights at your
  vertices. It is exact for three vertices and a least-squares fit for more. Use it
  when the ground around the feature slopes.
- **Lowest vertex**: a horizontal base at the lowest vertex height.
- **Custom height**: a horizontal base at an elevation you enter, in the DEM's
  vertical units. Until you enter one, no volume is shown: an empty field never
  means a base at zero.

On an imported reference DEM, heights, profiles and volumes include the raster's
declared **vertical offset** (Reference Data ▸ vertical info), the same correction
used when a GCP height is filled from it.

**Cut** is the volume above the base and **Fill** the volume below it.
**Net** is cut minus fill. Each DEM cell whose centre lies inside the polygon
contributes its height difference times its cell area, so a finer DEM follows the
polygon edge more closely. Place vertices on valid ground: a vertex on a nodata
cell gives no height, and the plane needs at least three vertices that are not
on one line.

**DEM coverage** reports how many cells inside the polygon actually have data.
Holes and parts of the polygon outside the raster are left out, not interpolated.
Below 100%, the volume is an underestimate of the area you drew, so fill holes
before measuring or redraw the polygon around them. The units are the DEM's
horizontal unit squared times its vertical unit, e.g. m³, or model units³ before
the project has a scale.

## Contours, slope and clipping
The **Tools → Products ▾** menu derives files from the DEM and orthophoto. None of
them changes the stored product.

- **Contours…** traces contour lines at an interval in the DEM's vertical unit
  (*0* picks a round interval for about 25 levels) and downloads them as **GeoJSON**
  (GIS) or **DXF** (CAD, with index contours on their own layer). Lines stop at
  nodata holes rather than cutting across them. Smoothing passes round the corners of
  the grid crossings; *0* keeps them exact.
- **Slope, aspect, hillshade…** writes each as a GeoTIFF on the DEM's grid and CRS
  (Horn's method, as in GDAL). Slope is in degrees or percent, aspect in degrees
  clockwise from north. In a projected CRS the grid spacing carries the projection's
  scale factor k, which is corrected at the DEM centre (heights are never scaled). A
  DEM in degrees of longitude/latitude is refused: its horizontal and vertical units
  differ.
- **Clip to polygon…** exports the DEM or orthophoto with everything outside a
  polygon set to nodata (transparent for the orthophoto), cropped to the polygon. The
  polygon is a saved **Area** or **Volume** measurement on that product, or a GeoJSON
  file already in the product's coordinates. A file in another CRS is not reprojected
  and would clip the wrong place.

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
requires a georeference fit and produces real-world coordinates. Once the project has
a georeference, Project CRS is preselected, so the DEM lands on the map's CRS view
with the basemap and GCPs. For an object with
a scale bar, Local is metric but still has no CRS.
Local levels the model from the cameras. When the camera positions share one height
(a drone flight plan) and the photos are oblique, that level plane sets the vertical;
a nadir survey uses its viewing direction. The log names which one was used.
The option names why it is unavailable. "Geographic CRS" means the project is still
in degrees (WGS 84): use the projected CRS suggested under the field, or choose one in
Project Settings; the frame switches to it once the fit is possible. "Needs ≥3 camera
positions or GCPs" means there is not enough evidence yet.

## Ground sample distance
<!-- param: gsd default: Auto -->
The raster's [ground sample distance](help:ground-sample-distance): cell size in
metres or model units per pixel. Auto estimates a sensible value from
point density. Choosing a much finer cell than the source spacing makes a larger file,
not more detail, and forces interpolation across more empty cells.

## Extent
<!-- param: extent default: Dense core -->
**Dense core** (default) grids only the area where the cloud is dense. Oblique photos
see far past the site, almost to the horizon, and those thin distant points would
otherwise make the DEM huge, coarse and mostly empty. The log says how many points
fall outside and are left out; a warning appears when that is more than 5%. Choose
**All points** to grid the full extent of the cloud. A Region (Tools ▸ Model ▸ Region)
limits the input before either.

## Points
<!-- param: points default: All points -->
**All points** (default) builds a surface model (DSM) from the whole cloud, roofs and
canopy included. **Ground only** builds a bare-earth terrain model (DTM) from the
ground class of a classified cloud: run [Classify Ground](guide:classify-ground)
first. It uses the cloud selected in the 3D view when that one is classified,
otherwise the newest classified cloud, and the Source line shows which. Choosing
Ground only turns on Fill enclosed gaps, because the ground under a removed
building is a hole the radius fill cannot close. A classified LiDAR survey imported
as a *streamed* cloud (too large for memory) is a ground source too.

## Surface aggregation
<!-- param: aggregate default: Max -->
How the heights of all points that land in one cell become that cell's single
height. **Max** (default) keeps the top surface: a DSM with roofs and canopy.
**Min** takes the lowest point, which is only "ground-ish": it drops some points on
low vegetation, but it is not a terrain model, and under trees or roofs there is no
ground in the cloud to find. For a terrain model, use Points ▸ Ground only. **Median** resists stray points above and
below the surface; **Mean** gives a smooth average where many points share a cell,
but one outlier pulls it. Median needs about 8 extra bytes per point (see Memory).

## Gap interpolation
<!-- param: fillMethod default: Inverse distance -->
Fills empty cells, which no point landed in, from measured cells nearby
([gap interpolation](help:gap-interpolation)). **Inverse distance** blends every
measured cell within the Interpolation radius, weighted by 1/distance², so small
holes close smoothly. **Nearest neighbour** copies the closest measured height: it
keeps steps such as roof edges and walls sharp, but fills look blocky. **None** keeps
the cells as nodata, which shows exactly where the cloud has no data; an orthophoto
built on this DEM is then transparent there.

## Interpolation radius
<!-- param: fillRadius default: 2 px -->
How far, in grid cells, an empty cell may be from a measured one and still be
filled. The radius never enlarges the raster: it only fills cells inside the grid,
and only from original measurements, never from other filled cells, so a hole wider
than twice the radius keeps an unfilled core. 1–2 closes the speckle between points
of a dense cloud. Larger values bridge real gaps (occluded ground, water, the space
between buildings) with invented surface, especially from a sparse cloud, whose
measured cells lie far apart. Because it counts cells, the same radius covers more
ground at a coarser ground sample distance.

## Fill enclosed gaps
<!-- param: fillHoles default: Off -->
Interpolates every empty area that measured cells surround on all sides, however
large: the ground under a removed building, or a pond. It runs after the radius
fill, with a smooth multi-resolution average of the measured cells around the gap
([gap interpolation](help:gap-interpolation)). Empty areas that reach the edge of
the grid are the edge of the survey and stay nodata. The filled heights are an
estimate, not a measurement: a building on a slope gets the slope continued under
it. On by default for Ground only, off otherwise.

## Show on the 2D map
Choose **On Map** in the DEM's ribbon tab, or **Display on map** in the Products row's
right-click menu. The row then shows ◉ and an **Opacity** slider while expanded. The
map draws the DEM's hillshade preview under GCPs and footprints, and above imported
reference rasters; **Fit View** includes it. With the cursor over it, the map's status
bar shows the height of the cell under the cursor, and "no data" over a hole.

The 2D map has two frames, switched with **View ▸ Map ▸ Model Frame**:
- **Project CRS** (Model Frame off): the basemap, GPS positions, GCPs, footprints,
  reference rasters and Project CRS products. A Local DEM is not drawn here; a
  note on the map says so.
- **Model frame** (on): a top-down view of the sparse model's local frame, labelled
  X/Y in model units (or metres with scale bars). It shows the registered cameras
  and Local products. Everything that only has a CRS position is hidden, and Edit
  GCPs is unavailable. Markers appear where their marks triangulate. A product
  built on an older sparse model, or in a different model orientation, is not drawn
  until it is rebuilt.

Until you choose, the map uses the model frame only when there is a sparse model and
nothing with a CRS position (no georeference, GPS, poses, GCP coordinates or
reference rasters on the map).

## Memory
The DEM copies the source cloud's points (about 24 bytes each, only those inside the
region when one is set) and allocates the grid. Both must fit the memory budget in
**Settings ▸ Compute**, the same budget dense matching uses. If a build is refused, the
message names the size it needed: raise the budget, set a region, subsample the cloud
(Tools ▸ Point Cloud ▸ Filter, voxel), or choose a coarser cell size for the grid.
Median uses about 8 extra bytes per point; Max, Min and Mean need none.

A *streamed* cloud ([level of detail](help:level-of-detail)) is read from its octree
instead: only as finely as the cell size needs (points about half a cell apart; finer
levels add nothing to a cell), and within half the budget, so a 0.5 m DTM of a
76-million-point survey reads some 20 million of them. With the cell size on auto,
the budget alone sets how finely it reads.

## Inspect before export
Look for spikes, pits, edge extrapolation, bridges across gaps, and a plausible height
range. Export GeoTIFF when the product has a CRS; preserve nodata for downstream GIS.

## Measure a raster
Every measuring tool is in **Tools ▸ Measure ▾**. With a DEM or orthophoto tab in
front, choose **Ruler**, **Area**, **Profile** or **Volume**. Profile and Volume need
elevations, so on an orthophoto they stay greyed with the reason. A bar at the top of
the view shows the active tool, and the Measure button stays lit while one runs.
Click vertices on the raster. **Enter** finishes, **Backspace** removes the last
point, and Shift-drag pans. **Esc** clears the drawing, and a second Esc leaves the
tool; choosing the active tool again in the menu also turns it off. A click after
Finish starts a new measurement.

**On the 2D map** the same menu works while a raster is on the map, and it adds a
**Map layer to measure** section that picks which raster is measured: the DEM by
default, because only a DEM serves Profile and Volume, so you can draw over the
orthophoto and still read heights from the DEM underneath. Drag pans; clicks add
vertices. A measurement saved on the map belongs to its raster, so it also appears
under **Saved measurements** in that raster's tab, and the other way round.

The same menu holds the measurements of clouds and meshes: **Distance to
reference…** and **Section…** (see Point Cloud Tools) and **Mesh area & volume…**
(see Mesh).

The result card shows the value with its details (perimeter for an area, elevation
range and relief for a profile, cut/fill/coverage for a volume). Type a name and
choose **Save measurement** to keep it with the project. **Saved measurements** in
the menu opens the list of this raster's saved measurements. Click one to reopen it, then
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
- **Reference DEM**: an imported reference DEM as the base, which turns the volume
  into a [DEM of difference](help:dem-of-difference) between two epochs. It is
  offered for the computed DEM in a CRS; **Tools ▸ Measure ▸ DEM of difference** opens
  the tool with it chosen. The result reads as **Gain** (the DEM above the reference)
  and **Loss** (below it). The reference is read at each DEM cell centre, bilinearly
  where its four surrounding cells have heights. A centre over a reference hole, or
  off the reference, counts as unmeasured and never borrows a neighbouring height, so
  **DEM coverage** shows the true overlap. Over a polygon of more than 262,144 cells
  (65,536 while you are still drawing it) the comparison uses a regular sub-grid of
  that many cells, scaled to the whole polygon, and the toolbox shows **Sampled: 1
  cell in n×n**. Only the reference base is sampled this way; the plane bases use
  every cell. Both DEMs must use the same vertical datum; the reference's declared
  offset is applied.

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

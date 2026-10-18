---
id: orthophoto
title: Build an Orthophoto
summary: Reprojects source imagery onto a DEM, mesh, or fitted plane to remove perspective.
category: Products and export
order: 90
---
An [orthophoto](help:orthophoto) uses the chosen surface for geometry and cached depth
maps for visibility. It therefore needs both depth maps and a DEM or mesh (a fitted
plane is available for genuinely flat scenes). Colour is read from the original photos
at full resolution, so the orthophoto can be as sharp as the photos even when the depth
maps were computed at a lower quality. The orthophoto is built in blocks of 2,048 ×
2,048 pixels, each from only the photos that see it; photos are kept in memory across
neighbouring blocks within the memory budget (Settings ▸ Compute), so a very fine
orthophoto decodes some photos more than once. If even one block, its photos and the
overviews do not fit the budget, the build stops and the log gives the figures.

## Surface
<!-- param: surface default: DEM -->
Use a **DEM** for terrain and overhead mapping, a **mesh** for complex or vertical 3D
shape, and a **plane** only when the scene is truly flat. Surface errors become image
displacement, double edges, or holes in the orthophoto.

## Coordinate frame
<!-- param: crs default: Local -->
With a **DEM** surface this field is hidden: the orthophoto inherits the DEM's frame
and grid, so rebuild the DEM to change it. For a **mesh** or **plane** surface,
choose the frame here, as in [Build DEM](guide:dem). **Local** uses the model
orientation and its best available scale; **Project CRS** requires a georeference
fit and produces real-world coordinates. Once the project has a georeference,
Project CRS is preselected, so the orthophoto lands on the map's CRS view with the
basemap and GCPs. Local levels the model from the cameras: when the camera positions
share one height (a drone flight plan) and the photos are oblique, that level plane
sets the vertical; a nadir survey uses its viewing direction, and the log names which
one was used. Project CRS needs a projected CRS; in a geographic one (WGS 84) the
field suggests one from the camera positions.

## Extent
<!-- param: extent default: Dense core -->
Mesh or plane surface only; a DEM surface keeps the DEM's grid and extent. **Dense
core** (default) covers only the area where the surface's points (the mesh's
vertices, or the cloud the plane is fitted to) are dense, as in Build DEM. Oblique
photos reach far past the site, and those thin distant points would otherwise make the
orthophoto huge and mostly empty. The log says how many points the core leaves out.
Choose **All points** to cover the full extent.

## Ground sample distance
<!-- param: gsd default: Auto -->
The orthophoto's pixel size on the ground
([ground sample distance](help:ground-sample-distance)), in the frame's units per
pixel. **0** (Auto) uses the surface's own cell size. The orthophoto's pixel size is
otherwise independent of the surface's: colour comes from the full-resolution photos,
so a 4,096-pixel DEM or mesh is enough for an orthophoto at the photos' own ground
resolution, tens of thousands of pixels across. A pixel finer than the photos' own
GSD adds file size and build time, not detail. The orthophoto is stored as a tiled
GeoTIFF of at most 4 GiB uncompressed (about 28,000 pixels square); a pixel size that
would exceed that over the surface's area is coarsened to fit, and the log says so.
To go finer, limit the area with Region and rebuild the surface.

## View blending
<!-- param: blend default: Mosaic -->
**Mosaic** (the default) builds the orthophoto the way mapping software does. Each
area comes from one photo, mostly the one that looks most straight down on it, so on
a regular flight the orthophoto is a patchwork of regions around each photo's centre.
**Seamlines** decides where the borders between those regions, the
[seams](help:seamline), run; **Colour balance** and **Seam blending** then hide them.

**Best match** takes each pixel from the view whose depth matched best. It can switch
source from one pixel to the next, which shows as speckled seams on uneven exposure.
**Average** blends every view that sees a pixel: smooth, but it ghosts moving objects
and small alignment errors. Both are kept for comparison. In every mode, depth
visibility stops images from painting through foreground surfaces.

The log's last orthophoto line reports sharpness and seam visibility: the colour step
across seams compared with the step inside one photo (×1 means seams do not show in
colour), and how many seam pairs there are per 100 pixels (a speckled source choice
scores high).

## Seamlines
<!-- param: seamline default: Graph cut -->
Mosaic only. Where the [seams](help:seamline) between photos run. A seam through a
building shows the roof leaning one way on one side and the other way on the other,
and a seam through a tree cuts it into two shapes, because tall objects look
different from each photo.

**Graph cut** (the default) places the seams where neighbouring photos agree: along
open ground and roads, around buildings and trees. It finds the labelling with the
lowest total cost ([graph cut](help:graph-cut)): every pixel costs a little more the
less straight down its photo looks, and every pixel of seam costs the colour
difference between the two photos there. The seams are placed once for the whole
orthophoto on a coarse grid of about a million cells, before the blocks; on a large
orthophoto one grid cell spans several pixels, so seams run in small steps that the
seam blending hides. It reads every photo once more at low resolution (shared with
Colour balance), and the log reports how many cells moved off their most nadir photo.

**Most nadir photo** gives each area to the photo that looks most straight down on
it, at the finest ground resolution, whatever lies there: the seams run halfway
between neighbouring photos' centres, like the cells of a Voronoi diagram. Isolated
single pixels are folded into the surrounding region.

## Colour balance
<!-- param: colourBalance default: on -->
Mosaic only. Evens out exposure: each photo gets one brightness gain per colour,
fitted so overlapping photos agree. The log lists the smallest, median and largest
gain. A gain far from 1 points at a photo with very different exposure, such as a
camera that changed its aperture during the flight; a gain that hits the 0.25–4 limit
(two stops either way) is reported as a warning. The fit reads every photo once more
at low resolution, which adds a short pass before the blocks.

## Seam blending
<!-- param: seamBlend default: Multiband -->
Mosaic only. How the two photos at a seam are mixed.

**Multiband** (the default, [multiband blending](help:multiband-blending)) splits
each photo into frequency bands and mixes each band over its own width: fine detail
switches from one photo to the other within a pixel or two, so a small misalignment
does not show as a double image, while brightness and colour fade over about a
hundred pixels, so no step shows either. Away from the seams every pixel keeps its
own photo's colour. Each block is computed with a border of about 200 pixels, so a
multiband orthophoto takes more time and memory than a feathered one; the log reports
both.

**Feather** cross-fades the two photos over a band of **Seam blending width**: hides
exposure steps with a wide band, but anything that does not line up shows as a soft
double image inside it.

## Seam blending width
<!-- param: seamWidth default: 1 % -->
Feather only. Cross-fades neighbouring photos over a band at each
[seam](help:seamline), given as a % of
the orthophoto's shorter side (at most 128 pixels). Wider bands hide exposure and
colour steps better, but small misalignments show as a soft double image inside the
band. **0** gives hard seams.

## Occlusion tolerance
<!-- param: depthTolRel default: 2 % -->
Decides whether a photo really sees a surface cell, using that photo's
[depth map](help:depth-map) as a z-buffer: the cell's distance from the camera must
agree with the depth map at that pixel to within this percentage of the distance (2 %
of 100 m is 2 m). A cell hidden behind something nearer, such as the ground behind a
wall, fails the test, so the photo cannot paint the wall's colour onto it. Too tight,
and errors in the surface or the depth maps make cells fail for every photo, which
leaves holes; too loose, and hidden surface takes the colour of whatever stands in
front of it, which shows as doubled edges beside tall objects. A pixel where the depth
map has no depth never counts as seeing a cell, whatever the tolerance.

## Max match cost
<!-- param: maxCost default: 0 (off) -->
An optional second gate: a photo's colour is not used where its depth map matched
poorly, that is where the depth map's matching cost (1 − NCC, from 0 for a perfect
match to 2) is above this value. It applies in every blending mode. **0** (the
default) turns the gate off, which is normally the right start: with Cross-view
consistency on, the depth maps' **Minimum NCC** filter has already removed every pixel
with a cost above 1 − Minimum NCC (0.9 at the default 0.1). A value at or above that
ceiling therefore changes nothing, and the dialog says so, naming the ceiling of the
depth maps you built. Set a value below it, such as 0.6, when weakly matched areas
(water, blank walls, moving objects) paint wrong colour. Lower values open holes where
the only views of a cell matched weakly.

## Colour gap interpolation
<!-- param: fillMethod default: Inverse distance -->
Fills pixels that no photo could colour (every view failed the occlusion or cost test,
or no photo covered them) from sampled pixels nearby
([gap interpolation](help:gap-interpolation)). It works only inside the surface: where
the surface itself has no height, such as a DEM hole, the pixel stays transparent.
**Inverse distance** blends the sampled colours within the Colour fill radius;
**Nearest neighbour** copies the closest one, which keeps edges crisp but looks
blocky; **None** keeps unsampled pixels transparent, which shows exactly where imagery
is missing. Interpolation is cosmetic: it cannot recover imagery hidden from every
camera.

## Colour fill radius
<!-- param: fillRadius default: 2 px -->
How far, in orthophoto pixels, an unsampled pixel may be from an originally sampled
colour and still be filled. Filled pixels never seed further fills, so a hole wider
than twice the radius keeps a transparent core. Keep it small: 1–3 closes speckles,
while a large radius smears colour across ground no camera saw. Large holes usually
mean missing coverage, a bad surface, or an Occlusion tolerance that is too tight.
Because it counts pixels, the same radius covers less ground at a finer ground sample
distance.

## Export
The orthophoto is stored as a Cloud-Optimized GeoTIFF (tiled, with overviews and
DEFLATE compression), so the **COG** export is that file as it is. **GeoTIFF** keeps
pixels and georeferencing in one plain file, optionally compressed; an uncompressed
one larger than 4 GiB is refused (choose DEFLATE or the COG). PNG and JPEG exports
are full resolution and paired with a world file and `.prj`; keep those sidecars
beside the image when moving it into GIS. They are offered up to 8,192 × 8,192
pixels; a larger orthophoto exports as a GeoTIFF. JPEG has no transparency, so
uncovered pixels become black.

Inspect seams, leaning objects, ghosting, holes, and boundary behaviour at full
resolution before using the result: the orthophoto's tab draws full-resolution tiles
as you zoom in, and its status bar reads the colour of the pixel under the cursor.
**Clip** reads only the part of the orthophoto the polygons cover, up to 8,192 ×
8,192 pixels.

## Show on the 2D map
Choose **On Map** in the orthophoto's ribbon tab, or **Display on map** in the
Products row's right-click menu. The row then shows ◉ and an **Opacity** slider while
expanded. The map draws the orthophoto at full resolution from its tiles, under GCPs
and footprints and above imported reference rasters; **Fit View** includes it.
Transparent (uncovered) pixels stay transparent. In the model frame, an orthophoto
whose local frame is shifted from the map's draws its preview image instead.

The 2D map has two frames, switched with **View ▸ Map ▸ Model Frame**:
- **Project CRS** (Model Frame off): the basemap, GPS positions, GCPs, footprints,
  reference rasters and Project CRS products. A Local orthophoto is not drawn here; a
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

## Measure an orthophoto
With the orthophoto tab in front, use **Ruler** or **Area** in **Tools ▸ Measure ▾**.
Click vertices, press Enter to finish, Backspace to remove the last point, and Esc
to clear (a second Esc leaves the tool). Shift-drag pans. On the 2D map, choose the
orthophoto under **Map layer to measure** in the same menu (see Build DEM ▸ Measure
a raster).
Results use the orthophoto's recorded units; in a projected CRS they are ground
lengths and areas, with the projection scale factor k divided out and shown. Type a name and choose **Save
measurement** to keep it with the project. **Saved** in the ribbon lists saved
measurements to reopen, rename or delete. Source or frame changes mark a saved
result stale.
Profile and Volume need elevations, so use them on a DEM tab. A geographic or
outdated frame cannot produce these linear measurements.


## Imported reference rasters
Reference imagery first appears as a preview, then gains tiled full-resolution
display in its tab and on the map. Pan and zoom request visible tiles. RGB band
mapping, grayscale, normalized-difference indices and gamma are drawn on the GPU;
manual ranges and changes that reuse existing ranges update without decoding the
image again. A new percentile range may need a small sample read.

The original file is retained for raw-value access: an imported orthophoto's tab
reads the raw values of its first bands under the cursor from it. A tiled copy with overviews is
prepared in the background and saved with the project; conversion jobs run one at
a time. Files beyond the conversion memory budget use their original GeoTIFF.
Unsupported display layouts use the preview. Display styles never change raw
values used for matching. Imported DEMs retain a separate elevation plane for
sampling and profiles. Raster tabs use tiled display for square-pixel rasters;
the map also supports rectangular pixels.

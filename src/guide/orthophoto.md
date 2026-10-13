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

## Coordinate frame and resolution
When a DEM is selected, the orthophoto inherits its frame. For mesh or plane, choose
Local or Project CRS; once the project has a georeference, Project CRS is preselected,
so the orthophoto lands on the map's CRS view with the basemap and GCPs.
Local levels the model from the cameras. When the camera positions share one height
(a drone flight plan) and the photos are oblique, that level plane sets the vertical;
a nadir survey uses its viewing direction. The log names which one was used. With a mesh or plane surface, **Extent** works as in Build DEM: the dense
core by default, or all points. Project CRS needs a projected CRS; in a geographic one (WGS 84)
the field suggests one from the camera positions (see Build DEM). Auto resolution
follows the surface; a smaller pixel size than the imagery and surface support does
not add real detail. The orthophoto's pixel size is independent of the surface's: a
4,096-pixel DEM or mesh is enough to build an orthophoto at the photos' own ground
resolution, tens of thousands of pixels across. It is stored as a tiled GeoTIFF of at
most 4 GiB uncompressed (about 28,000 pixels square); a pixel size that would exceed
that over the surface's area is coarsened to fit, and the log says so. To go finer,
limit the area with Region and rebuild the surface.

## Blending
<!-- param: blend default: Mosaic -->
**Mosaic** (the default) builds the orthophoto the way mapping software does. Each
area comes from the photo that looks most straight down on it, at the finest ground
resolution, so on a regular flight the orthophoto is a patchwork of regions around
each photo's centre. Isolated single pixels are folded into the surrounding region.
Two options then hide the seams:
<!-- param: colourBalance default: on -->
- **Colour balance** evens out exposure: each photo gets one brightness gain per
  colour, fitted so overlapping photos agree. The log lists the smallest, median and
  largest gain. A gain far from 1 points at a photo with very different exposure; a
  gain that hits the 0.5–2 limit is reported as a warning. The fit reads every photo
  once more at low resolution, which adds a short pass before the blocks.
<!-- param: seamWidth default: 1 % -->
- **Seam blending width** cross-fades neighbouring photos over a band at each seam,
  given as a % of the orthophoto's shorter side (at most 128 pixels). Wider bands hide
  exposure and colour steps better, but small misalignments show as a soft double image
  inside the band. **0** gives hard seams.

**Best match** takes each pixel from the view whose depth matched best. It can switch
source from one pixel to the next, which shows as speckled seams on uneven exposure.
**Average** blends every view that sees a pixel: smooth, but it ghosts moving objects
and small alignment errors. Both are kept for comparison. In every mode, depth
visibility stops images from painting through foreground surfaces.

The log's last orthophoto line reports sharpness and seam visibility: the colour step
across seams compared with the step inside one photo (×1 means seams do not show in
colour), and how many seam pairs there are per 100 pixels (a speckled source choice
scores high).

## Occlusion and cost gates
Depth tolerance controls how closely an image observation must agree with the surface.
Too tight creates holes; too loose can paint hidden surfaces. The optional matching-cost
gate can reject weak depth evidence but is normally best left disabled initially.

## Fill gaps
Colour interpolation fills unsampled pixels inside the selected surface. Keep the
radius small: interpolation is cosmetic and cannot recover imagery hidden from every
camera. Large holes usually indicate missing coverage, a bad surface, or over-strict
visibility checks.

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

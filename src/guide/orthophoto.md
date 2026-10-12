---
id: orthophoto
title: Build an Orthophoto
summary: Reprojects source imagery onto a DEM, mesh, or fitted plane to remove perspective.
category: Products and export
order: 90
---
An [orthophoto](help:orthophoto) uses the chosen surface for geometry and cached depth
maps for visibility. It therefore needs both depth maps and a DEM or mesh (a fitted
plane is available for genuinely flat scenes).

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
not add real detail.

## Blending
<!-- param: blend default: Best -->
**Best** chooses the sharpest suitable observation and usually preserves detail.
**Average** can soften seams and noise but may blur moving objects or small alignment
errors. Depth visibility prevents images from painting through foreground surfaces.

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
GeoTIFF keeps pixels and georeferencing in one file. PNG and JPEG exports are paired
with a world file and `.prj`; keep those sidecars beside the image when moving it into
GIS. Inspect seams, leaning objects, ghosting, holes, and boundary behaviour at full
resolution before using the result.

## Show on the 2D map
Choose **On Map** in the orthophoto's ribbon tab, or **Display on map** in the
Products row's right-click menu. The row then shows ◉ and an **Opacity** slider while
expanded. The map draws the orthophoto's preview image under GCPs and footprints, and
above imported reference rasters; **Fit View** includes it.

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

The original file is retained for raw-value access. A tiled copy with overviews is
prepared in the background and saved with the project; conversion jobs run one at
a time. Files beyond the conversion memory budget use their original GeoTIFF.
Unsupported display layouts use the preview. Display styles never change raw
values used for matching. Imported DEMs retain a separate elevation plane for
sampling and profiles. Raster tabs use tiled display for square-pixel rasters;
the map also supports rectangular pixels.

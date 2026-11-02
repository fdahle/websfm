---
id: orthophoto
title: Build an Orthophoto
summary: Reprojects source imagery onto a DEM, mesh, or fitted plane to remove perspective.
category: Products and export
order: 90
---
An [orthophoto](help:orthophoto) projects the photos onto a surface (a DEM, a mesh, or a
plane for flat scenes) and uses the depth maps to tell which photo sees each point, so
it needs both. Colour comes from the original photos at full resolution, so the
orthophoto can be as sharp as the photos even from lower-quality depth maps.

It is built in blocks over all compute workers (Settings ▸ Compute) within the memory
budget; the log says how many workers and how far the run has got. A large orthophoto
takes minutes.

## Surface
<!-- param: surface default: DEM -->
A **DEM** for terrain and mapping, a **mesh** for complex or vertical shapes, a
**plane** only for truly flat scenes. Errors in the surface show as displacement,
double edges or holes. The [main](help:main-product) DEM or mesh is used; right-click
another ▸ **Set as main** to change it.

## Coordinate frame
<!-- param: crs default: Local -->
Over a DEM, the orthophoto takes the DEM's frame and grid. Over a mesh or plane, choose
it as in [Build DEM](guide:dem): **Local** is the model's own frame; **Project CRS**
gives real-world coordinates, needs a georeference and a projected CRS, and is
preselected once there is one.

## Extent
<!-- param: extent default: Dense core -->
Mesh or plane only. **Dense core** covers only where the surface is dense, leaving out
the thin far points of oblique photos; **All points** covers everything.

## Raster size by
<!-- param: sizeBy default: Cell size -->
Set the size as a **Cell size** or as the **Long side** in pixels; the other follows.
The line under the field shows the size the run will build.

## Ground sample distance
<!-- param: gsd default: Auto -->
The pixel size on the ground ([ground sample distance](help:ground-sample-distance)).
**0** (Auto) takes the surface's cell size. It can be much finer than the surface,
down to the photos' own resolution, since colour comes from the photos; finer than
that adds size, not detail. The limit is 65,535 pixels a side; a finer size is
coarsened to fit, and Region limits the area.

## Long side
<!-- param: longSide default: Auto -->
The number of pixels on the longer side; the cell size follows. **0** (Auto) takes the
surface's cell size.

## Occlusion tolerance
<!-- param: depthTolRel default: 2 % -->
A photo colours a point only where its [depth map](help:depth-map) agrees with the
surface to within this share of the distance (2 % of 100 m is 2 m), so hidden ground
behind a wall doesn't take the wall's colour. Too tight leaves holes; too loose gives
doubled edges beside tall objects.

## Max match cost
<!-- param: maxCost default: 0 (off) -->
Optionally ignores a photo's colour where its depth map matched poorly (cost above
this, 0–2). **0** turns it off, usually right since the depth maps are already
filtered. Try 0.6 when water, blank walls or moving objects get wrong colours; lower
values open holes.

## View blending
<!-- param: blend default: Mosaic -->
**Mosaic** works like mapping software: each area comes from one photo, mostly the one
looking most straight down, joined along [seams](help:seamline) that colour balance and
seam blending hide. **Best match** takes each pixel from the best-matched view
(speckled seams); **Average** blends all views (smooth, but ghosts). The log reports
sharpness and how visible the seams are.

## Seamlines
<!-- param: seamline default: Graph cut -->
Mosaic only: where seams between photos run. **Graph cut** places them where
neighbouring photos agree, along open ground and around buildings and trees
([graph cut](help:graph-cut)). **Most nadir photo** gives each area to the photo looking
most straight down, so seams run halfway between photo centres and can cut through
roofs and trees.

## Colour balance
<!-- param: colourBalance default: on -->
Mosaic only: one brightness gain per photo and colour, so overlapping photos agree. The
log lists the gains; one far from 1 points at a photo with very different exposure.

## Seam blending
<!-- param: seamBlend default: Multiband -->
Mosaic only: how photos mix at a seam. **Multiband**
([multiband blending](help:multiband-blending)) switches fine detail within a pixel or
two but fades brightness over a wide band, so neither double images nor steps show; it
costs more time and memory. **Feather** cross-fades over **Seam blending width**, which
blurs misalignments into a soft double image.

## Seam blending width
<!-- param: seamWidth default: 1 % -->
Feather only: the cross-fade band at each [seam](help:seamline), in % of the
orthophoto's shorter side. Wider hides exposure steps better but blurs misalignment.
**0** gives hard seams.

## Colour gap interpolation
<!-- param: fillMethod default: Inverse distance -->
Fills pixels no photo could colour from nearby ones
([gap interpolation](help:gap-interpolation)), only where the surface has a height.
**Inverse distance** blends, **Nearest neighbour** copies the closest, **None** leaves
them transparent. It is cosmetic: it can't recover what no camera saw.

## Colour fill radius
<!-- param: fillRadius default: 2 px -->
How far, in pixels, a gap may be from a coloured pixel and still be filled. Keep it
small (1–3) to close speckle; large holes mean missing coverage, a bad surface or too
tight an occlusion tolerance.

## Replace the main orthophoto
<!-- param: replaceMain default: Off -->
Off, the new orthophoto is added beside the others ("Orthophoto 2") and becomes the
[main orthophoto](help:main-product). On, it takes the main one's place and name. Either
way, products built on the old one are kept and marked outdated.

## Export
The orthophoto is stored as a Cloud-Optimized GeoTIFF, so the **COG** export is that
file. **GeoTIFF** is one plain file; uncompressed it is limited to 4 GiB. **PNG** and
**JPEG** (up to 8,192 pixels a side) come with a world file and `.prj`; keep them beside
the image. Inspect seams, leaning objects, ghosting and holes at full resolution in the
orthophoto's tab before use.

## Alpha band
<!-- param: orthoAlpha  default: on -->
Empty pixels are marked transparent by a fourth band, which GIS reads as no data.
Untick it for software that wants three bands with a **NODATA value** instead.

## NODATA value
<!-- param: orthoNodata  default: 0 -->
The grey level (0 black – 255 white) of empty pixels without an alpha band. Real pixels
of exactly that colour are shifted by one level so they don't read as holes. JPEG
always uses it.

## Export coordinate system
<!-- param: rasterCrs default: As built -->
**As built** writes the orthophoto in its own CRS. **Another CRS…** writes a reprojected
Cloud-Optimized GeoTIFF at the same cell size. A Local orthophoto cannot be
reprojected.

## Export resampling
<!-- param: resampling default: Bilinear -->
How a reprojected copy samples colours. **Bilinear** is smoother; **Nearest** keeps
each pixel's colour exactly.

## Show on the 2D map
A new orthophoto goes on the 2D map at full resolution; its checkbox in the Products
section takes it off and puts it back, and its row has an **Opacity** slider. **View ▸
Map ▸ Layers** sets the stacking order of everything on the map, and **View ▸ Map ▸
Model Frame** switches between the project CRS and the model's local frame (see
[Build DEM](guide:dem)).

## Measure an orthophoto
With the orthophoto open, **Tools ▸ Measure ▾** offers **Ruler** and **Area** (Profile
and Volume need a DEM). In a projected CRS, results are ground lengths and areas. Name
a result and **Save measurement** to keep it.

## Imported reference rasters
An imported raster first shows a preview, then full-resolution tiles as a tiled copy
is prepared in the background and saved with the project. Band mapping, grayscale,
indices and gamma change only the display, never the values used for matching.

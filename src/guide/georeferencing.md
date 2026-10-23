---
id: georeferencing
title: Georeferencing & Scale
summary: Places the model in real-world coordinates using control, camera positions, or a known distance.
category: Alignment and accuracy
order: 70
---
A reconstruction initially has arbitrary position, orientation, and scale
([gauge freedom](help:gauge-freedom)). Georeferencing fits it to the project
[coordinate reference system](help:coordinate-reference-system); a scale bar gives
metric scale without a geographic CRS.

## Choose the project CRS
Coordinates for cameras, GCPs, reference rasters, and exported products must be
interpreted consistently. For accurate distance and elevation work, a projected
CRS suited to the site remains the best output coordinate system. Sparse
reconstruction does not require one, however: camera positions in a geographic CRS
are automatically converted to a survey-centred metric frame for adjustment while
the selected project CRS remains unchanged. The same holds in a projected CRS: map
grid coordinates are scaled by the projection's scale factor and ignore Earth
curvature, so the fit, GCP anchoring and camera positions are all solved in a local
metric frame around the site and converted back to the CRS. The log reports the
scale factor k it divided out; near the poles this removes metres of error.

Georeferenced products are the exception: a DEM or orthophoto in the project CRS
needs a projected CRS, because the model cannot be fitted to degrees. New projects
start in WGS 84 (EPSG:4326). When the project CRS is geographic and the cameras have
positions (EXIF GPS or imported), websfm suggests a projected CRS: the UTM zone of
the median camera position, or polar stereographic beyond UTM's range (EPSG:3031 in
the far south, EPSG:3413 in the far north). The log names the suggestion when the
GPS positions are read. **Project Settings** and the Build DEM / Build Orthophoto
frame field offer it as one click. Applying it reprojects positions, GCPs and
footprints; nothing changes until you click. A national grid (e.g. Lambert-93,
EPSG:2154 in France) works just as well; pick it in the CRS list.

## Camera positions
Imported or EXIF positions can fit the reconstruction when at least three registered
cameras have usable 3D coordinates. They are convenient but consumer GNSS may be too
weak for survey accuracy. Check residuals rather than assuming the metadata is exact.
The reconstruction log reports when geographic positions are converted for bundle
adjustment and later reports the camera-prior residual.

With accurate positions (RTK/PPK, a few centimetres), the camera-position adjustment also
re-solves focal length and lens distortion. A nadir drone block calibrated from its own
images alone tends to bend into a shallow dome. Accurate positions are what corrects
it. Give imported positions their real accuracy, because the 5 m default carries almost
no weight.

By default the positions are taken as the camera centres. An RTK antenna usually sits
0.1–0.5 m from the lens. Enter that offset per sensor in the **Sensor table**: the
**GNSS** button on the sensor's row opens three fields, in metres and camera axes (x
right, y down in the image, z forward along the view). The positions are then treated
as antenna positions. Metashape gives its GNSS offset with y up and z backward, so enter
its (x, y, z) as (x, −y, −z). Without the offset, expect a horizontal camera residual of
about the offset's length, and a self-calibrated principal point pulled off by the
offset's size in pixels. On a 444-image RTK block, entering it cut the camera residual
from 41 cm to 2 cm. Checkpoints are the better accuracy test either way.

## Ground control points
A GCP needs known 3D coordinates and image marks. For adjustment, use at least three
enabled control points, each marked in two registered images; more well-distributed
control is far better. Spread points across the area and elevation range, and keep
independent checkpoints out of the fit when you need an honest accuracy test.

**Import → GCP File** reads a table with a point name and its coordinates, optionally
with one row per image the point is marked in (image name plus pixel x/y). When a file
carries several coordinate pairs, the dialog takes longitude/latitude (and preselects
WGS 84) over a projected pair such as `x_map`/`y_map`. A bare `x`/`y` next to an image
column is read as the pixel position. Change any column it guessed before importing.
A file with image marks but no coordinates adds those marks to the points of the same
name. Names not yet in the project become markers, which are never used as control.

To place marks, open an image and choose **Tools → Images ▾ → Edit GCPs**: a
click on the image then marks the GCP selected in the sidebar, or adds a new one. With
the 2D map in front, the same entry places and moves the surveyed points on the map
instead. Choose it again to leave the mode; a right-click on an image or the
map adds a point without entering it.

## Adjust or transform
**Adjust reconstruction with GCPs** rebuilds the sparse model with control inside
bundle adjustment. It is the stronger choice after adding good control, but invalidates
depth maps, dense output, DEM, orthophoto, and mesh. **Transform current reconstruction**
fits scale, rotation, and translation only, preserving its internal geometry.

## Scale bars
For an object or local model, mark two reconstructed points and enter their measured
distance. Multiple scale bars can reveal inconsistent marking. Scale bars provide
metric units but no real-world origin or CRS.

## Verify accuracy
Inspect GCP and camera residuals in the Quality Report. A low fitting residual is not
proof of external accuracy when all control lies in one corner or one plane. Look for
spatial patterns and compare withheld checkpoints where possible.

## Reference raster alignment
Imported GeoTIFFs are placed the way GDAL reads them, including point-registered
(PixelIsPoint) files and tiepoints that are not at the first pixel. A raster imported
before 3 October 2026 keeps the position it was imported with. If a point-registered
DEM looks shifted by half a cell, remove it and import it again.

A reference DEM is held at full resolution in one buffer of 4 bytes per cell, and the
browser caps one buffer at 2 GiB: about 23,000 × 23,000 cells. A 64-bit (Float64) DEM
is first read at 8 bytes per cell, so its limit is about 16,000 × 16,000. A larger DEM
(a REMA 2 m tile is 25,100 × 25,100) is read only over the project: the area of its
images' positions (GPS or imported camera positions) and its GCPs, grown by half its
extent and by at least 1 km on each side. When even that area is too large, it is read at
a whole multiple of its cell size (2 m instead of 1 m), resampled bilinearly, and the log
says so with a warning. The map still draws the whole file at full resolution. Without
image positions or GCPs the DEM is refused with its size: import a coarser copy (for
example `gdal_translate -tr 4 4`) or crop it to your area with `-projwin`. Orthophotos are drawn as tiles and have no such limit for display.

## Pick GCPs off a reference raster
Without survey data, a georeferenced orthophoto and DEM of the area can stand in
for it: often the only option for historical imagery. Open the reference raster
from **Reference Data**, zoom in on a feature you can also find in your photos,
right-click it and choose **Add GCP here**. With a GCP selected, **Move <name> here**
moves that point instead.

The GCP's X/Y is the clicked point, converted to the project CRS. Its σ X/Y is one
pixel of the reference measured in the project CRS, its
[GSD](help:ground-sample-distance), or more when you click zoomed out or while only
the preview is drawn: a click is good to one pixel as you see it. In a geographic
project CRS σ is in metres. When the raster declares a horizontal accuracy, that
and the pixel combine in quadrature.

Z comes from a reference DEM at that point: the raster itself when it is a DEM,
otherwise the default reference DEM. It is taken only when the DEM declares a
vertical accuracy, which becomes σ Z. A moved GCP keeps its own height datum when the
DEM's converts to it; a new one takes the DEM's. Without a declared accuracy, Z is
left as it was and the log says why, just as **Fill Z** does. Then mark the point in
at least two photos as usual.

## Height datums
Every GCP and reference DEM declares what its heights are measured from: its
[vertical datum](help:vertical-datum). Set a GCP's in the GCP table's Uncertainty
column or when importing the file, and a DEM's with **Accuracy & datum…**. The datum
select only says what the numbers already are. To change the numbers, use **Convert
heights to…** in the GCP table's toolbar. It adds the geoid separation at each
point's own position and converts ellipsoidal, EGM96 and EGM2008 heights; other
points are skipped and logged. Converting refits the georeference.

**Fill Z**, **Check Z** and a GCP picked off a reference convert the DEM's height into
the GCP's declared datum when both convert. The log shows the shift. A GCP with
an unknown datum takes the DEM's.

The georeference records the datum its control shares and passes it to the DEM
built in it. Control in mixed datums biases the fit, and the log says so.
**Evaluate ▸ DEM vs Reference** and the DEM-of-difference volume then convert the
reference to that datum and report the shift they added.


## Reference raster accuracy
<!-- param: horizontalAccuracy default: unknown -->
Right-click a raster in **Reference Data** and choose **Accuracy & datum…** to
declare how good it is. **Horizontal accuracy** is the 1σ error of its ground
position, in metres, as its producer states it. Orthophoto archives often quote CE90
or RMSE; divide CE90 by 2.15 for σ. For a DEM the same dialog sets the vertical
datum, the vertical accuracy that GCP heights taken from it claim, and a vertical
offset added to every height. A low-confidence import asks for these straight away;
a confident one needs this dialog.

## Find candidate GCPs from a reference orthophoto
Build an orthophoto, import a georeferenced reference raster, then open **Reconstruct →
Find GCPs**. Choose a reference band and select **Find candidates**. The matcher
works [coarse to fine](help:coarse-to-fine):

1. **Where to look.** If the orthophoto is already georeferenced, the search starts
   from its footprint in the reference. Otherwise it starts from the registered
   photos' image footprints, imported (**Import**, a polygon file with image names,
   as archives such as USGS EarthExplorer supply them) or computed from poses,
   padded by a quarter of their extent. Footprints say where an oblique photo looks,
   which its camera position does not. Without footprints it starts from the
   photos' GPS positions, padded by half their spread and at least 300 m. Without
   any of these, it searches the whole reference. A footprint that misses the
   reference stops the search with that message.
2. **Coarse.** SIFT runs on a 1,536-pixel look at the whole orthophoto and at the
   search area, and one RANSAC [homography](help:homography) aligns them. If that
   fails, the search area is tried again as 3 × 3 overlapping windows of half its
   size, then 5 × 5 windows of a quarter. A block that is only a few dozen pixels
   of a regional tile then gets two or four times as many pixels to match on.
   Each success is refined by a second look at just the predicted footprint.
3. **Fine.** Tiles of up to 512 pixels are laid over the orthophoto, up to 6 × 6
   of them. Both sides are read at the coarser of the two native resolutions,
   because neither raster can place a feature better than that. A tile keeps its
   matches only when they sit near the coarse prediction, at least 10 agree on
   the tile's own homography, at least 30 % of its matches agree, and they spread
   over at least a fifth of the tile in both directions. Repeated texture matches
   itself in a tight cluster, and the last rule rejects it. A per-tile model
   follows relief and doming that one plane cannot. Tiles that are mostly empty
   orthophoto are skipped.

The fine pass needs the stored orthophoto file. An orthophoto record without one
uses the coarse alignment only, and the message says so. Large rasters are read
from their overviews, so a coarse look at a 30,000-pixel orthophoto does not decode
it at full resolution.

The numbered overlays and table show candidate locations. Each candidate is an
existing sparse track measured in at least two source photos, lying within 2
working pixels of a verified match. Its reference coordinate is that matched
feature moved by the track's offset, using the tile's own homography. Up to 30 are
kept, spread over the block: the best one in each cell of a 5 × 5 grid first, then
the next best anywhere. The message gives how many of 16 cells they cover and the
share of the block inside their outline. Control bunched in one corner fits that
corner only.

For each candidate the table shows:
- **Confidence**, from 0 to 100 %. It multiplies the share of the tile's matches
  that agreed, the inlier count (full credit from 30), how closely this match sits
  on its tile's model (one working pixel off gives 61 %), and 80 % for a track seen
  in only two photos. Use it to order your review, not as acceptance.
  **Select confidence ≥ 50 %** ticks those rows for you to review.
- **Residual**: the match's distance from its tile model, in working pixels.
- **σ XY**: prefilled from the reference [GSD](help:ground-sample-distance). It is
  one reference pixel measured in the project CRS, or the residual in reference
  pixels when that is larger. If the reference raster declares a horizontal
  accuracy (**Accuracy & datum…**), σ is that accuracy and the residual combined in quadrature.
  Edit it if you know better.

Choose **Review** for side-by-side project/reference close-ups, cut from the
candidate's fine tile at working resolution, and the source-photo marks. Check
only candidates that identify the same stable feature.

In the same dialog, enter elevation and coordinate accuracies (positive 1σ values
in project units), or select a reference DEM and **Fill selected heights**. DEM
filling copies its declared vertical accuracy and datum; nodata, out-of-bounds
locations, and DEMs without declared accuracy leave the candidate unchanged.
Choose **Checkpoint** to reserve a point for checking rather than fitting.
**Add reviewed candidates** imports only checked rows. Unknown elevation and
accuracy stay unknown; incomplete controls cannot constrain adjustment. Photo
marks can still be refined later in Control & Markers.

## Stable ground
<!-- param: stableArea  default: Anywhere -->
A polygon layer that marks ground which has not changed between the photos and the
reference: rock outcrops beside a glacier, built-up areas, bedrock. With one chosen,
only candidates whose reference position lies inside a polygon are kept, and the
spread over the block picks from those. **Anywhere** keeps every candidate.

Use it whenever the photos are older than the reference. A candidate on a glacier,
a river bank or a pit face matches a feature that has since moved or a surface whose
height has changed, so both its position and the height filled from a reference DEM
are wrong. Import the outlines as a polygon file (**Import**, GeoJSON) in any CRS;
they are converted to the project CRS. The result line says how many matches fell
outside.

Some scenes defeat this matcher: a heavily changed historical scene, a reference
whose radiometry differs strongly (film against a multispectral band), or a block
too small to find in a regional reference without GPS. In the last case, crop the
reference to the area first. A failed alignment creates no control; use manual
marks or a more suitable reference instead. Closing the search dialog discards
pending search results.

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

To place marks, open an image and choose **Tools → Georeferencing → Edit GCPs**: a
click on the image then marks the GCP selected in the sidebar, or adds a new one. With
the 2D map in front, the same button places and moves the surveyed points on the map
instead. Click it again to leave the mode; a right-click on an image or the
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
(a REMA 2 m tile is 25,100 × 25,100) is refused with its size. Import a coarser copy (for
example `gdal_translate -tr 4 4`) or crop it to your area with `-projwin`. Orthophotos
are drawn as tiles and have no such limit for display.

## Find candidate GCPs from a reference orthophoto
Build an orthophoto, import a georeferenced reference raster, then open **Tools →
Find GCPs**. Choose a reference band and select **Find candidates**. The matcher
uses SIFT and a robust planar alignment of the project preview and a bounded raw
reference-band read. Repeated gamma/stretch changes reuse cached preview bands;
the first read of a new band can still require a source decode.

The numbered overlays and table show candidate locations. Choose **Review** for
side-by-side project/reference close-ups and available source-photo marks. Check
only candidates that identify the same stable feature. Each candidate uses an
existing sparse track measured in at least two source photos; its reference
coordinate is a local estimate near a verified match, not a surveyed point.

In the same dialog, enter elevation and coordinate accuracies (positive 1σ values
in project units), or select a reference DEM and **Fill selected heights**. DEM
filling copies its declared vertical accuracy and datum; nodata, out-of-bounds
locations, and DEMs without declared accuracy leave the candidate unchanged.
Choose **Checkpoint** to reserve a point for checking rather than fitting.
**Add reviewed candidates** imports only checked rows. Unknown elevation and
accuracy stay unknown; incomplete controls cannot constrain adjustment. Photo
marks can still be refined later in Control & Markers.

A heavily changed historical scene, repetitive texture, very different scales, or
relief that violates the planar model can defeat this matcher. A failed alignment
creates no control; use manual marks or a more suitable reference in that case.
Closing the search dialog discards pending search results.

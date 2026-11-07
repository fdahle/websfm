---
id: georeferencing
title: Georeferencing & Scale
summary: Places the model in real-world coordinates using control, camera positions, or a known distance.
category: Alignment and accuracy
order: 70
---
A reconstruction starts with arbitrary position, orientation and scale
([gauge freedom](help:gauge-freedom)). Georeferencing fits it to the project
[coordinate reference system](help:coordinate-reference-system); a scale bar gives
metric scale without a CRS.

## Choose the project CRS
Cameras, GCPs, reference rasters and products all use the project CRS. Sparse
reconstruction works in any CRS: positions are converted to a local metric frame for
the adjustment and back. DEMs and orthophotos in the project CRS need a projected CRS.
New projects start in WGS 84; when the cameras have positions, WebSfM suggests their
UTM zone (or polar stereographic near the poles), offered as one click in **Project
Settings** and the DEM and orthophoto dialogs. Any projected CRS, such as a national
grid, works as well.

## Camera positions
GPS or imported camera positions georeference the model once three registered cameras
have them. Consumer GNSS is metres off, so check the residuals. Accurate positions
(RTK/PPK) also correct the dome a nadir block can bend into; give them their real
accuracy, as the defaults carry little weight: 10 m across and 20 m in height for photo
GPS, 5 m for a position file without accuracies. A position file's accuracy columns are
recognised by names such as `sigma_x`, `accuracy_z` or `Std Dev e (m)`; check that the
import mapped them.

An RTK antenna sits some centimetres from the lens. Enter that offset per sensor with
the **GNSS** button in the **Sensor table**, in metres in camera axes (x right, y down,
z forward). Metashape's (x, y, z) is (x, −y, −z) here. Without it, expect a camera
residual about the offset's length.

## Ground control points
A GCP needs 3D coordinates and marks in at least two registered images; use at least
three, spread over the area and its height range. Keep some as checkpoints for an
honest accuracy test.

**Import ▸ GCP File** reads a table of point names and coordinates, optionally with
image marks (image name, pixel x/y). Check the columns it guessed before importing. To
mark points, open an image and choose **Tools ▸ Images ▾ ▸ Edit GCPs**; with the 2D map
in front, the same entry places the surveyed points on the map. Right-click adds a
point directly.

## Method
<!-- param: method  default: Adjust with GCPs when three are marked -->
**Adjust with GCPs** re-runs bundle adjustment with the control: the stronger choice,
but it outdates the depth maps and products. **Hold to a reference DEM** re-runs it
with the tie points held to a reference DEM as well (below). **Transform only** moves,
rotates and scales the model, keeping its shape: quick, and nothing needs rebuilding.
A greyed-out method says on hover what it is missing.

## Hold to a reference DEM
A block held only by drone GPS, or by a few GCPs, can bend: it domes or dishes by
metres at its edges while every residual looks fine. **Hold to a reference DEM**
rebuilds the sparse model with each tie point over stable ground pulled toward a
reference DEM's height ([reference DEM hold](help:reference-dem-hold)), so the block
keeps the ground's shape. The GCPs or camera positions still place it; the DEM only
keeps it from bending. Use it for blocks without good control and for historical
photos. It is experimental: keep a few GCPs as check points to see what it did.

## Reference DEM to hold
<!-- param: holdReference  default: The first imported -->
The DEM the tie points are held to: a lidar survey or a global DEM. **Copernicus DEM
(30 m)** fetches the free [Copernicus DEM](help:copernicus-dem) around the camera
positions and GCPs. Declare its [vertical datum](help:vertical-datum) and your
control's, so the heights are converted; otherwise the model is shifted by the
difference.

## Height uncertainty
<!-- param: holdSigma  default: The DEM's vertical accuracy, else 2 -->
How far, in metres (1σ), a tie point may sit from the reference's height. It starts at
the DEM's declared vertical accuracy. Thousands of tie points average the DEM's noise,
so even a loose value takes out a bend; lower it for a lidar DEM, raise it where the
reference is coarse against the terrain's relief.

## Stable ground to hold
<!-- param: holdStable  default: Everywhere -->
A polygon layer of ground unchanged between the photos and the reference: rock, roads.
Only tie points inside it are held. Without one, points far from the DEM's height are
left out on their own, but a large change (a glacier, a new pit, forest in a surface
model) is better excluded with a layer.

## Scale bars
For an object or a local model, mark two points and enter their measured distance.
Several scale bars reveal marking errors. Scale bars give metric units, not a CRS.
While you mark a point, a Scale bar toolbox shows how many photos it is marked in;
**Back to scale bars** returns to the dialog, and it reopens by itself after the second
photo.

## Verify accuracy
Check GCP and camera residuals in the Quality Report. A low residual proves little when
all control lies in one corner or one plane; look for patterns and use checkpoints.

## Reference raster alignment
Imported GeoTIFFs are placed as GDAL reads them. A reference DEM larger than the
browser can hold (about 23,000 cells a side) is read only around the project's images
and GCPs, coarser if needed, and the log says so. Without positions it is refused:
import a coarser or cropped copy (`gdal_translate -tr` or `-projwin`).

## Pick GCPs off a reference raster
Without survey data, a georeferenced orthophoto and DEM can stand in, often the only
option for historical images. Open the raster from **Reference Data**, right-click a
feature you can also find in your photos and choose **Add GCP here** (or **Move
<name> here**). X/Y is the clicked point, with σ of one reference pixel. Z is read from
a reference DEM when it declares a vertical accuracy. Then mark the point in at least
two photos.

## Height datums
Every GCP and reference DEM declares its [vertical datum](help:vertical-datum): in the
GCP table's Uncertainty column or on import, and with **Accuracy & datum…** for a DEM.
Declaring a datum doesn't change the numbers; **Convert heights to…** in the GCP
toolbar does (ellipsoidal, EGM96, EGM2008). Heights read from a DEM are converted to
the GCP's datum. Control in mixed datums biases the fit, and the log warns.

## Reference raster accuracy
<!-- param: horizontalAccuracy default: unknown -->
Right-click a raster in **Reference Data** ▸ **Accuracy & datum…** to declare its
**horizontal accuracy**, the 1σ error of its positions in metres (CE90 ÷ 2.15). For a
DEM, also its vertical datum, vertical accuracy and any vertical offset. GCPs taken
from the raster inherit these accuracies.

## Find candidate GCPs from a reference orthophoto
Build an orthophoto, import a georeferenced reference raster, and open **Reconstruct
▸ Find GCPs**. It aligns your orthophoto to the reference [coarse to
fine](help:coarse-to-fine): first the whole image within the **Search area**, then
tile by tile, and proposes sparse points that match a reference feature as control.

The result table lists each candidate with a **Confidence** (to order your review, not
to accept blindly; **Select confidence ≥ 50 %** ticks those rows), its **Residual**
and its **σ XY** from the reference's pixel size and accuracy. Click a row for
side-by-side close-ups and keep only candidates on the same stable feature. Fill
heights from a reference DEM in step 4, mark some as **Checkpoint**, and **Add
candidates** imports the ticked rows.

It can fail on heavily changed scenes, references with very different radiometry, or
a small block in a large reference without positions; crop the reference then, or
mark control by hand.

## Sentinel-2 reference
Without a reference raster of your own, **Sentinel-2…** fetches a free
[Sentinel-2](help:sentinel-2) image (10 m, true colour) of the search area. **Search
scenes** lists the scenes, best first: full coverage, then least cloud, then newest.
Click one to see its whole tile with a box on the part that will be read; **Fetch**
imports that part as a reference orthophoto with σ XY 8 m. Prefer a scene from the
same season as the photos.

## Max cloud
<!-- param: sentinel2Cloud  default: 20 -->
The most cloud a scene may have to be listed, in percent of its whole 110 km tile.
Cloud elsewhere on the tile doesn't matter, so raise it when nothing is listed and use
the preview to check the area. **From** and **To** limit the dates.

## Search area
<!-- param: searchArea  default: Auto -->
Where in the reference to look. **Auto** takes the best the project knows: the
orthophoto's georeferenced footprint, the photos' footprints, their GPS positions,
else the whole reference; the line under the field says which. Footprints work best;
**Compute footprints…** makes them from poses ([Footprints from
poses](guide:footprints-from-poses)). A polygon layer limits the search to its
polygons.

## Coarse matcher
<!-- param: coarseMatcher  default: Auto -->
What aligns the whole orthophoto first. **DISK** or **SuperPoint + LightGlue**
(learned; Auto takes SuperPoint when its weights are installed) match across decades
and sensors, such as film against a satellite image. **SIFT** is quickest, for similar
images such as a recent drone survey against a recent orthophoto. **Terrain** fits the
sparse cloud to a reference DEM by [ICP](help:icp) where no image matches (snow,
cloud), from a start within a few hundred metres; it is less precise than an image
matcher.

## Reference band
<!-- param: referenceBand  default: Mean of bands 1–3 (RGB) -->
Which band of the reference is matched. The mean of bands 1–3 suits panchromatic film
against a colour image; a single band can match better for infrared film.

## Candidates
<!-- param: candidates  default: 90 -->
How many candidates to propose, spread evenly over the block. More, well-spread
candidates hold the model's tilt better; fewer suit a block with little stable ground.

## Stable ground
<!-- param: stableArea  default: Anywhere -->
A polygon layer of ground unchanged between the photos and the reference (rock,
buildings). Only candidates inside it are kept. Use it whenever the photos are older
than the reference: points on glaciers, river banks or pits have moved since.

## Role
<!-- param: role  default: Control point -->
A **Control point** takes part in the fit. A **Checkpoint** is left out, and the
Quality Report measures the model's error at it, the honest accuracy test. Keep about
one in five as checkpoints when you have enough.

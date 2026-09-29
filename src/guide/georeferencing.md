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
the selected project CRS remains unchanged.

## Camera positions
Imported or EXIF positions can fit the reconstruction when at least three registered
cameras have usable 3D coordinates. They are convenient but consumer GNSS may be too
weak for survey accuracy. Check residuals rather than assuming the metadata is exact.
The reconstruction log reports when geographic positions are converted for bundle
adjustment and later reports the camera-prior residual.

## Ground control points
A GCP needs known 3D coordinates and image marks. For adjustment, use at least three
enabled control points, each marked in two registered images; more well-distributed
control is far better. Spread points across the area and elevation range, and keep
independent checkpoints out of the fit when you need an honest accuracy test.

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

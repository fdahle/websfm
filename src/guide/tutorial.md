---
id: tutorial
title: Tutorial: Your First Reconstruction
summary: Take the example drone survey from photos to a point cloud, an elevation model and an orthophoto, one step at a time.
category: Start here
order: 0
---
This walkthrough uses the example project: 42 photos of Aukerman Park in Ohio, taken
from a small drone about 70 m above the ground. They come from
[OpenDroneMap's example data](https://github.com/OpenDroneMap/odm_data_aukerman),
shared as public domain (CC0 1.0); thank you, OpenDroneMap. To
open it, choose **Open the example project** in the New Project dialog, or **Try an
example** in the project picker (click the project name at the top left). Each step
below says what to click, what to expect, and what to look at before going on. The
times were measured on a desktop with a graphics card; a laptop may take two or three
times as long.

Keep this guide open beside the app: the **Guide** button under **Other** brings it
back if you close it.

## 1 · Look at the photos
The 42 images are in the sidebar on the left. Click one to open it in its own tab.
The photos carry GPS positions, so the **2D** tab (the map) already shows where
each was taken, and the project uses the matching map projection (UTM zone 17 N, EPSG:32617).
The flight crossed the park in parallel lines, so every spot on the ground is in
several photos. That overlap is what makes 3D possible.

## 2 · Detect features
**Reconstruct ▸ Detect Features**, keep **Balanced**, and press **Run**. WebSfM
finds thousands of distinctive points in every photo (corners, edges of paths,
patches of texture), using [SIFT](help:sift). It takes about half a minute. Open a photo
and press **Keypoints** in the **Picture** tab of the ribbon to see them.

See [Detect Features](guide:detect-features) for the settings.

## 3 · Match the photos
**Reconstruct ▸ Match Features**, keep the defaults, **Run**. Every pair of photos
is compared, and the pairs that show the same ground are kept: about 270 of the 861
pairs here. This takes seconds with a graphics card and one to two minutes
without. **Evaluate ▸ Matching** shows the pairs
as a graph: photos taken next to each other should be linked.

See [Match Features](guide:match-features).

## 4 · Build the sparse model
**Reconstruct ▸ Sparse Model**, **Run**. WebSfM works out where each camera was and
how it was turned, together with a cloud of about 15,000 3D points, in about 20
seconds. You can watch the model grow in the 3D view. Expect all 42 cameras to
register, with a median
reprojection error around 0.6 pixels: on average, each 3D point lands within a pixel
of where the photos saw it.

The photos' GPS positions take part in this adjustment, so the model already has
real-world scale and position. Consumer GPS is good to a few metres, so the model's
position is too; for centimetres you would add ground control points
([Georeferencing](guide:georeferencing)).

This is the first real checkpoint. In the 3D view the cameras should form the flight
lines above a flat cloud of points. **Evaluate ▸ Quality Report** summarises every
stage and points out weak spots, such as images with few matches. See
[Sparse Reconstruction](guide:sparse-reconstruction) and
[Quality Report](guide:quality-report).

## 5 · Compute depth maps
**Reconstruct ▸ Depth Maps**, keep **Medium**, **Run**. For every photo, WebSfM now
estimates the distance to every pixel, using its neighbours ([depth map](help:depth-map)).
This is the slowest step. With a graphics card (WebGPU, available in current Chrome
and Edge) it takes under a minute. Without one it runs on the processor's cores, and the
log says *using WASM (CPU)*: then choose **Low**, which takes about a minute on an
eight-core machine instead of several at Medium. Low still makes a usable cloud, DEM
and orthophoto, at about 40 cm per pixel instead of 18 cm.

See [Depth Maps](guide:depth-maps).

## 6 · Fuse the dense cloud
**Reconstruct ▸ Dense Model**, **Run**. The depth maps are merged into one dense
point cloud of about 2.5 million coloured points (fewer at Low), where the sparse
model had thousands. This takes seconds.
Look at it in the 3D view: the trees, the pond, the shelter and the cars in the car
park should be recognisable.

See [Dense Cloud](guide:dense-cloud).

## 7 · Make an elevation model and an orthophoto
**Reconstruct ▸ DEM**, **Run**. This grids the dense cloud into a
[digital elevation model](help:digital-elevation-model): one height per cell. Because
the cameras have GPS positions, the dialog's coordinate frame is already the project's
map projection (EPSG:32617), so the DEM appears in the **2D** tab over the basemap:
about 330 × 240 m with cells of 18 cm, built in a second or two.

Then **Reconstruct ▸ Ortho**, **Run**. The [orthophoto](help:orthophoto) is a map
made from the photos: every pixel is seen from straight above, at true scale, so you
can measure on it. WebSfM picks the best photo for each area and hides the seams
between them, in about 15 seconds. Compare it with the basemap in the **2D** tab: paths and buildings
should line up to within a few metres.

See [DEM](guide:dem) and [Orthophoto](guide:orthophoto).

## 8 · Measure and export
Use **Tools ▸ Measure** to measure a distance or an area on the map, or a height
profile across the DEM. **Export ▸ Products** writes the DEM and the orthophoto as
GeoTIFFs, which open in QGIS or ArcGIS; **Export ▸ Geometry** writes the point cloud
as LAS, LAZ or PLY.

## Where next
- Try it with your own photos: [Getting Started](guide:getting-started) explains what
  makes a good photo set.
- Repeat the whole chain with one click: the [Workflow Builder](guide:workflow-builder)
  under **Reconstruct**.
- Something looks wrong? The console (**Other ▸ Console**) logs every step, and the
  Quality Report shows where a model is weak. The 🐞 button reports a problem.

The project is saved in your browser as you go. To keep a copy, use
**Other ▸ Save a Copy…**; to remove it, use the **⋯** menu in the project picker.

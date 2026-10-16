---
id: getting-started
title: Getting Started
summary: The shortest reliable route from a folder of overlapping photos to a checked 3D result.
category: Start here
order: 1
---
websfm runs the whole photogrammetry pipeline locally in your browser. Your source
images are not uploaded. Start with the balanced defaults, inspect the result after
each major stage, and only tune a setting when the evidence tells you why.

## 1 · Create a project
Choose **Aerial survey** when you need a map, real-world coordinates, a DEM, or an
orthophoto. Choose **Object capture** for a standalone object or local scene; you can
set its scale later with a known distance. For aerial work, select a projected CRS
appropriate to the site before importing control data.

Browser storage is automatic and private to this browser profile. On Chromium you
can instead keep the project in a normal folder. See [Projects & storage](guide:projects-storage)
before clearing browser data or moving machines. websfm also starts without a
connection once it has been opened online; see [Working Offline](guide:offline).

## 2 · Import good images
Import a set with strong overlap, consistent focus and exposure, and viewpoints that
move around the subject. Avoid long runs of almost identical frames, motion blur,
featureless sky, and reflective or moving surfaces. [Mask](guide:masks) irrelevant
regions when they dominate the image.

For an aerial block, roughly **70–80% forward overlap** and **60–70% side overlap**
is a useful starting point. Object captures need continuous coverage around the
subject plus some height variation. **Tools → Images ▾ → Image quality** ranks the
set by sharpness and flags blurred or badly exposed frames before you spend time on
them (see [Image Quality, Region and Orientation](guide:model-tools)).

16-bit TIFFs (multispectral and scientific cameras) are converted to 8-bit for viewing
and feature detection by stretching each image between its darkest and brightest
0.5 % of pixels, so a sensor that uses only part of its 16-bit range still gives full
contrast. The log records each image's stretch. For a multi-band camera such as a
MicaSense, import one band (the panchromatic band where there is one); each band file
is treated as a separate image. Remove frames taken on the ground before takeoff.

**Very large scans.** A TIFF more than 30,000 pixels on a side, or over 200
megapixels (a full-resolution KH-9 mapping-camera scan is about 65,700 × 32,900), is
larger than the browser can hold as one picture. websfm then reads the file in strips
and stores it as a *tiled pyramid*: tiles at full resolution plus successive halvings.
The log notes *Large TIFF … building a tiled pyramid* and then the number of levels
and tiles. Such scans are imported one at a time and take a while; the pyramid is
saved with the project, or rebuilt from the original when it is missing (for example
from a `.websfm` saved without derived data). Detection, depth maps and fiducial
detection then read only the level and the part of the scan they need. The image view
shows a reduced copy, at most 8,192 pixels wide. Painting masks and placing GCP or
fiducial marks by hand are not available on these images yet, and the view says so.
Masks still work: [Auto mask](guide:masks), mask import, Invert and **Generate
background masks** store the mask at 8,192 pixels on the long side, and detection
and depth maps scale it up to the scan.

**Organising a large set.** Right-click images in the sidebar and choose **New group
from selection** to put them in a named, collapsible group (for example per flight or
per strip). Add more images with **Move to group**, or drag rows onto a group header.
Ctrl-click (⌘-click) and Shift-click select several images. Groups only organise the
list: they never change detection, matching or reconstruction, and the capture order
used by sequential matching stays the order the images were imported in. Removing a
group keeps its images. Images that must share one camera calibration belong in the
same **sensor**, which is a different thing from a group.

**Thumbnails.** The image table, the mask dialogs and the camera frames in the 3D view
show a small thumbnail of each image, made once in the background when the image is
added and stored with the project, so long lists stay quick with thousands of images.
A project from an older version has none yet: each image's thumbnail is made the first
time a list or the 3D view shows it, and a grey shimmer stands in until then. The
full-resolution image is still what the image viewer, detection and dense matching use.

## 3 · Reconstruct
Run [Detect Features](guide:detect-features), [Match Features](guide:match-features),
then [Sparse Reconstruction](guide:sparse-reconstruction). The sparse model is your
first real checkpoint: cameras should form the expected path and the point cloud
should resemble the scene without detached clusters.

Open the [Quality Report](guide:quality-report) before spending time on dense output.
Fix missing images, weak links, or poor calibration at the sparse stage.

To save and repeat a sequence of commands, use the
[Workflow Builder](guide:workflow-builder) in the Reconstruct tab.

## 4 · Add scale or coordinates
Camera positions or ground control can place an aerial reconstruction in the project
CRS. For an object, add a scale bar between two points whose real distance is known.
Do this before creating final products, because a ground-control adjustment invalidates
depth maps and downstream products. An object project can also be levelled and given
an origin with **Tools → Model ▾ → Orient model**.

## 5 · Make the result
Build [Depth Maps](guide:depth-maps), fuse them into a [Dense Cloud](guide:dense-cloud),
then choose the output you need:

- [Mesh](guide:mesh) for a continuous 3D surface.
- [DEM](guide:dem) for a gridded elevation surface.
- [Orthophoto](guide:orthophoto) for scale-correct overhead imagery; it needs depth
  maps plus a DEM or mesh surface.

Clean, align, compare and measure the results with the **Tools** tab's
[Point Cloud](guide:point-cloud-tools), Mesh and Products menus. A
**Region** (Tools → Model ▾) keeps depth maps and fusion to the area you care about.

## Where things are
The ribbon chooses what to do: a dialog, a mode, or a display setting such as point
and camera size (View → Scene). **Every tool is in the Tools tab**, grouped by what
it acts on: Images, Model, Georeferencing, Point Cloud, Mesh, Products and Measure,
mostly as menus. The View tab and the tabs that appear for an open image or raster
only show things: camera presets, overlays, zoom, styling, on-map. Every menu opens
even before anything in it is usable, so you can see what is there: a tool whose
prerequisite is missing stays in its menu, greyed, with the reason. Interactive tools
(selecting points, editing masks or ground control, measuring, region, orientation,
point-pair alignment) act on the view in front and open a small floating toolbox over
it; while one runs, its menu button stays lit. You can drag the toolbox by its title,
and close it with × or Esc.

## If something goes wrong
Read the operation log first: it records skipped images, resolved pixel thresholds,
memory decisions, and the stage that failed. Then check the Quality Report. Changing
many advanced settings at once makes the cause harder to find; change one thing,
rerun the earliest affected stage, and compare.

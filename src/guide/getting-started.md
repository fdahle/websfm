---
id: getting-started
title: Getting Started
summary: The shortest reliable route from a folder of overlapping photos to a checked 3D result.
category: Start here
order: 1
---
WebSfM runs the whole photogrammetry pipeline in your browser; your images are not
uploaded. Start with the defaults, check the result after each major stage, and change
a setting only when the result tells you why. The [Tutorial](guide:tutorial) walks
through an example drone survey.

## 1 · Create a project
Choose **Aerial survey** for maps, real-world coordinates, DEMs and orthophotos, and
**Object capture** for an object or local scene (scale it later with a known distance).
Projects live in browser storage, or on Chromium in a folder on your disk; see
[Projects & storage](guide:projects-storage) and [Working Offline](guide:offline).

## 2 · Import good images
Use images with strong overlap, sharp focus and steady exposure, taken from viewpoints
that move around the subject. Avoid near-identical frames, blur, sky and moving or
reflective surfaces; [mask](guide:masks) what doesn't belong. For an aerial block,
aim for about 70–80 % forward and 60–70 % side overlap. **Tools ▸ Images ▾ ▸ Image
quality** flags blurred or badly exposed frames (see
[Image Quality, Region and Orientation](guide:model-tools)).

**Import ▸ Video** extracts sharp, overlapping frames from a video (see
[Import Video](guide:video-import)). Images already in the project are caught on import:
**Skip duplicates** or **Add anyway**.

16-bit TIFFs are stretched to 8 bits per image. For a multi-band camera, import one band
per image. Scans too large for the browser to hold as one picture (over 30,000 pixels
a side) are stored as a tiled pyramid and read in parts; hand-painting masks and
placing marks by hand isn't available on those yet.

**Organise** with right-click ▸ **New group from selection**; groups only sort the list.
Images that share one calibration belong in the same **sensor**. Right-click ▸
**Disable** leaves images out of later runs without deleting anything; **Enable**
brings them back.

## 3 · Reconstruct
Run [Detect Features](guide:detect-features), [Match Features](guide:match-features),
then [Sparse Reconstruction](guide:sparse-reconstruction). Check the sparse model: the
cameras should follow the expected path and the points resemble the scene without
detached clusters. Open the [Quality Report](guide:quality-report) and fix missing
images, weak links or poor calibration now. The
[Workflow Builder](guide:workflow-builder) saves a sequence of steps to repeat.

## 4 · Add scale or coordinates
Camera positions or ground control place an aerial model in the project CRS; a scale
bar scales an object. Both are under **Georeferencing** in the Reconstruct tab. Do this
before the final products: an adjustment with control retires the depth maps, and older
products are marked [outdated](help:main-product). **Tools ▸ Model ▾ ▸ Orient model**
levels an object and sets its origin.

## 5 · Make the result
Build [Depth Maps](guide:depth-maps) and a [Dense Cloud](guide:dense-cloud), then:
- a [Mesh](guide:mesh) for a continuous 3D surface;
- a [DEM](guide:dem) for a gridded elevation surface;
- an [Orthophoto](guide:orthophoto) for scale-correct overhead imagery (needs depth maps
  and a DEM or mesh).

The **Tools** tab's [Point Cloud](guide:point-cloud-tools), Mesh and Products menus
clean, align, compare and measure. A **Region** (Tools ▸ Model ▾) limits the dense steps
to your area. Right-click a result ▸ **Show information** for what it holds and how it
was made.

## Leaving a long run
Dense clouds and fine orthophotos can take hours. The tab title shows the stage and its
progress, and the screen is kept on while the tab is visible (Settings ▸ General).
**Notify when a run ends** sends a desktop notification when a run ends or a workflow
needs you.

## Where things are
The **Reconstruct** tab holds the pipeline steps; **every tool is in the Tools tab**,
in a menu per subject: Images, Model, Point Cloud, Mesh, Products, Measure. The View tab
only changes what you see. A tool that can't run yet stays in its menu, greyed with the
reason. Interactive tools open a small toolbox over the view (close with × or Esc).
Hover a button for its shortcut; **?** lists them all. **What's New** lists the changes
of each version.

The Reconstruct dialogs (Detect Features, Match Features, Sparse Model, Depth Maps,
Dense Cloud, DEM, Orthophoto, Mesh, Reflectance) and the Tools that take the longest to set up (Texture Mesh, Contour
Lines, Co-register DEM, Align to Reference, Detect Targets) open on the settings of
their last run in this project. **Presets ▾**
in a dialog's title bar saves the current settings under a name, for the next project of
the same kind, brings a saved set back, or resets to the defaults.

## Supported browsers
**Chrome and Edge** support everything; WebGPU (depth maps and matching on the graphics
card) depends on the driver. **Firefox** runs the whole pipeline, but on the CPU only,
with a 2 GB starting memory limit (raise it in Settings ▸ Compute), browser storage
only, and large exports downloaded rather than written where you choose. **Safari**
passes the browser tests but hasn't been tried on real data. **Other ▸ System info ▸
Browser support** shows what this browser offers.

## If something goes wrong
A red note at the bottom right opens the console on an error. Read the log first: it
records skipped images, thresholds, memory decisions and the failing stage. Then check
the Quality Report. Change one setting at a time, rerun the earliest affected stage, and
compare.

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
before clearing browser data or moving machines.

## 2 · Import good images
Import a set with strong overlap, consistent focus and exposure, and viewpoints that
move around the subject. Avoid long runs of almost identical frames, motion blur,
featureless sky, and reflective or moving surfaces. Mask irrelevant regions when
they dominate the image.

For an aerial block, roughly **70–80% forward overlap** and **60–70% side overlap**
is a useful starting point. Object captures need continuous coverage around the
subject plus some height variation.

16-bit TIFFs (multispectral and scientific cameras) are converted to 8-bit for viewing
and feature detection by stretching each image between its darkest and brightest
0.5 % of pixels, so a sensor that uses only part of its 16-bit range still gives full
contrast. The log records each image's stretch. For a multi-band camera such as a
MicaSense, import one band (the panchromatic band where there is one); each band file
is treated as a separate image. Remove frames taken on the ground before takeoff.

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
depth maps and downstream products.

## 5 · Make the result
Build [Depth Maps](guide:depth-maps), fuse them into a [Dense Cloud](guide:dense-cloud),
then choose the output you need:

- [Mesh](guide:mesh) for a continuous 3D surface.
- [DEM](guide:dem) for a gridded elevation surface.
- [Orthophoto](guide:orthophoto) for scale-correct overhead imagery; it needs depth
  maps plus a DEM or mesh surface.

## If something goes wrong
Read the operation log first: it records skipped images, resolved pixel thresholds,
memory decisions, and the stage that failed. Then check the Quality Report. Changing
many advanced settings at once makes the cause harder to find; change one thing,
rerun the earliest affected stage, and compare.

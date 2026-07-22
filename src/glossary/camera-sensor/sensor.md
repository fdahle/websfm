---
id: sensor
title: Sensor
aliases: sensors, camera model, sensor group
summary: A camera definition shared by many images — sensor size, focal length and distortion — so one set of intrinsics is solved for the whole group.
---
A **sensor** in WebSfM is not a piece of hardware but a *grouping*: the set of
images that were taken with the same camera in the same configuration, and
therefore share one set of [camera intrinsics](help:camera-intrinsics). Every
image is assigned to exactly one sensor.

The grouping is what makes calibration tractable. A hundred photos from one
camera give a hundred [poses](help:camera-pose) but only *one* focal length,
principal point and distortion model to solve for — a hundred times more
evidence per parameter than treating each image independently. Splitting a group
that should be shared (or merging two that should not be) is one of the more
consequential mistakes available in the project setup, because it changes what
[self-calibration](help:self-calibration) is even allowed to conclude.

A sensor definition carries:

- **Physical sensor size** in millimetres, which converts a
  [focal length](help:focal-length) in mm into pixels.
- **Focal length**, from EXIF or entered by hand.
- A **distortion model** — pinhole, radial, radial2, or full Brown–Conrady —
  declaring which coefficients this camera actually uses. Only the active
  model's terms are applied and refined; declaring more terms than the data
  supports invites overfitting.
- A **kind**: a normal digital camera, or `film` for a scanned analogue frame,
  which additionally carries [fiducial marks](help:fiducial-marks) and a
  calibration certificate.

<!-- TODO(image): assets/sensor-grouping.svg - a set of image thumbnails partitioned into two sensor groups, each group pointing at a single shared K matrix and distortion block, with the per-image pose R,t shown as the only thing that varies within a group. -->

WebSfM auto-groups images into sensors from EXIF (camera make, model, focal
length, image dimensions), which is right for most digital projects. It has to
be corrected by hand when EXIF is absent or misleading — scanned film, a zoom
lens used at different settings, or two physically different cameras that report
the same model string.

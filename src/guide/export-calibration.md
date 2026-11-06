---
id: export-calibration
title: Export Calibration
summary: Write the camera calibration, as entered or as bundle adjustment refined it, to a CSV that the calibration import reads back.
category: Products and export
order: 109
---
**Export ▸ Calibration** writes the [camera intrinsics](help:camera-intrinsics):
[focal length](help:focal-length), [principal point](help:principal-point),
[lens distortion](help:lens-distortion) model and coefficients, image size and pixel
size. The file has the columns **Import ▸ Calibration** reads, so a calibration can be
carried into another project of the same camera.

**Format** is CSV or tab-separated text; both read back the same way.

## Source
<!-- param: source  default: Estimated, one row per camera group, when the sparse model has cameras; else As entered -->
**As entered** writes each camera group ([sensor](help:sensor)) as the Sensor table
shows it: what you typed, imported or WebSfM read from the photos.

**Estimated by the reconstruction** writes what [bundle adjustment](help:bundle-adjustment)
ended with: the focal length and principal point in pixels, averaged over the group's
registered cameras (**one row per camera group**), or each camera's own (**one row per
image**, with an `image` column the import uses to assign each row). `focal_y` is the
focal length along the image's y axis and `cameras` how many cameras a row averages.
For a film camera, the values are in pixels of the film frame its fiducials define,
not of the scan.

The lens columns hold the lens the model was solved with: the group's own, or the one
[self-calibration](help:self-calibration) solved. A model from an older version of
WebSfM may instead have radial terms fitted *on top* of the group's own lens; they are
written apart, as `selfcal_k1` to `selfcal_k3`, and cannot be added to its k1 to k3. The import leaves these columns alone, so the file brings back
the focal length, principal point and the group's own lens model.

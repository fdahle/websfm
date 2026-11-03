---
id: import-metashape
title: Import Metashape Cameras
summary: Brings the calibration, camera positions and orientations, the markers with their marks and the scale bars from an Agisoft Metashape project into this one.
category: Reconstruction pipeline
order: 12
---
**Import ▸ Metashape Cameras** reads the XML file Metashape writes with **File ▸
Export ▸ Export Cameras**, or with **Export Markers**, which holds the same and the
markers too. Use it to carry work done in Metashape into WebSfM: a calibrated camera,
an alignment to start from, or GCPs you have already marked. Load the photos first;
the file names its cameras by photo name.

You choose what comes:

- **Calibration**: each Metashape camera becomes a camera group with its focal length,
  principal point and lens distortion (k1–k3, p1, p2), and its photos join it. Terms
  WebSfM does not model (Metashape's k4, b1, b2) are left out, and the dialog says how
  far they move a corner of the photo.
- **Camera positions and orientations** of the aligned cameras, in the project's
  coordinate system, as priors for [Sparse Model](guide:sparse-reconstruction). The
  heights are ellipsoidal. A chunk in a local frame has no coordinates to give, so its
  cameras stay behind.
- **GCPs and markers** with the marks placed in Metashape. A marker whose reference is
  turned off comes as a check point, one without coordinates as a marker. Points join
  GCPs here of the same name. Metashape's own projections (the unpinned flags) are not
  marks anyone placed, so they stay behind.

- **Scale bars** between markers or between cameras, with their distance and
  accuracy; one whose reference is turned off comes left out of the fit, as a check.
  A bar between markers needs them here, imported with it or already of the same name.

## Back to Metashape

**Export ▸ SfM Project ▸ Metashape XML** writes the registered cameras, their
calibration, the GCPs with their marks and the scale bars between them, for **File ▸ Import ▸ Import Cameras** and
then **Import Markers** in Metashape (the same file for both). A georeferenced project
goes out in WGS 84 with ellipsoidal heights, converted from EGM96 or EGM2008 where
the georeference uses one; otherwise the cameras stay in a local frame. Each camera
group's lens, including what self-calibration added on top, is fitted to Metashape's
model; the log names a group the fit misses by more than 0.05 px. Film scans are left
out.

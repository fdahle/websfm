---
id: import-metashape
title: Import Metashape Cameras
summary: Brings the calibration, camera positions and orientations, and the markers with their marks from an Agisoft Metashape project into this one.
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

Scale bars are not read: add them again in **Scale bars**.

---
id: reseau
title: Reseau
aliases: reseau, reseau grid, reseau crosses, réseau
summary: A grid of small crosses on a glass plate in front of the film, exposed onto every frame, whose measured positions reveal how the film was placed on the scanner and how it has deformed.
---
A **reseau** (French for *network*) is a regular grid of fine crosses etched onto a
glass plate that sits directly in front of the film in some metric cameras, such as
the KH-9 Hexagon mapping camera (a 1 cm grid). Every exposure records the crosses
together with the scene. Their true positions are known from the camera's
calibration, so where they land in a scan says two things at once:

- how the scan is placed — the shift, rotation and pixel size the scanner gave it,
  as [fiducial marks](help:fiducial-marks) also do;
- how the film itself has stretched, shrunk or warped since it was exposed. With
  hundreds of crosses instead of four fiducials, that deformation is measured
  locally, centimetre by centimetre, not only as an overall scale.

Film bases change size unevenly with age, humidity and processing. Tens of
micrometres are common, several pixels of a fine scan, and an
[affine](help:fiducial-marks) fit of a few fiducials cannot remove a deformation that
varies across the frame. Correcting each scan by its own crosses puts every image
point back where the camera exposed it.

The crosses are also features a matcher can latch onto: they sit at the same scan
position in every image, so matches between them carry no information about the
scene. The **stationary points** filter in Match Features removes them.

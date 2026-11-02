---
id: reseau
title: Detect Reseau
summary: Measure the reseau crosses on scanned film so each scan is corrected for its placement on the scanner and its own film deformation.
category: Reconstruction pipeline
order: 16
---
Some metric film cameras expose a [reseau](help:reseau), a grid of small crosses, onto
every frame. **Detect Reseau** (Tools → Images ▾ → Film scans) finds the crosses in
every scan of a sensor and measures each against its nominal position. Reconstruction
then corrects each scan by its own crosses: the scan's placement (shift, rotation,
pixel size) and the film's deformation between the crosses, interpolated smoothly.

The sensor needs its **scan pixel size** (mm per pixel) and the certificate's focal
length in mm. After detection it becomes a **Film** sensor with a reseau calibration;
run Sparse Reconstruction again to use it. Self-calibration on **Auto** then keeps the
certificate values, since the film deformation is already measured (see
[Sparse Reconstruction](guide:sparse-reconstruction)). Turn on **Ignore stationary
points** in Match Features too, so the crosses don't match each other.

The scan must show the whole frame, centred to within half a grid cell. Frames
scanned in two halves are stitched instead (see **Scans** below).

## Scans
<!-- param: mode  default: Half frames when the scans pair up -->
**Whole frames** measures the crosses on each scan as it is. **Half frames** is for
archives that scan a frame in two overlapping parts, as the KH-9 mapping camera's
frames are: `<frame>_a` is the left of the film and `<frame>_b` the right (`-a` / `-b`
works too). The dialog pairs the scans by name and offers this mode when it finds
pairs.

The two halves are aligned by their crosses and their overlapping image content, and
stitched into one image, `<frame>.tif`, on the film's own grid, corrected for
placement and film deformation. GCP marks move with them. The stitched frames share a
new sensor with the certificate values. A pair whose overlap can't be decided is
reported and left as it is. Film size isn't needed in this mode.

## Remove the halves
<!-- param: removeHalves  default: on -->
Removes each pair's two halves from the project once its frame is stitched, so
reconstruction uses only the stitched frame. Turn it off to keep the halves for a
comparison; leave them out of reconstruction then, since every half repeats half of
its frame.

## Sensor
The sensor whose scans are searched. Only sensors with a scan pixel size are listed.

## Cross spacing
<!-- param: spacingMm  default: 10 mm -->
The distance between neighbouring crosses on the film, from the camera's
documentation: 10 mm for the KH-9 mapping camera. A wrong spacing places the lattice
on the wrong crosses or on none.

## Film size
<!-- param: filmSize  default: the scan size × the scan pixel size -->
The width and height of the film frame the lattice covers, in millimetres. They start
from the first scan's size in pixels times the scan pixel size. Crosses beyond the
scan's edge are skipped, so a slightly large value costs nothing.

## Cross arm
<!-- param: armMm  default: 0.5 mm -->
The length of one arm of a cross, from its centre. A shorter value than the real arms
still finds the crosses, using only their middle; a longer one adds scene texture to
every measurement.

## Line width
<!-- param: widthMm  default: 0.03 mm -->
The width of a cross's lines on the film. Below one scan pixel it is treated as one
pixel.

## Results
Per scan the dialog lists the crosses found, the film deformation they measured
(µm RMS) and what is left after correction, usually a few micrometres of measurement
noise. Crosses that disagree with their neighbours are left out as outliers. For half
frames it also lists the lattice and how many columns the halves share.

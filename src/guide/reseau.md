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

The sensor needs its **scan pixel size** (mm per pixel) in the sensor table, and the
camera's focal length in millimetres from its calibration certificate. Detection
reads every scan at full resolution, a small window per cross, so even satellite
frames of two gigapixels take well under a minute each.

After detection the sensor becomes a **Film** sensor with a reseau calibration, and
each image's crosses appear as its fiducial marks. Run Sparse Reconstruction again to
use them. With self-calibration on **Auto**, a reseau-calibrated camera keeps its
certificate values: its film deformation is already measured, and solving lens
distortion against a short strip of wide-angle frames bends the whole block instead
(see [Sparse Reconstruction](guide:sparse-reconstruction)). Turn on **Filter stationary
points** in Match Features as well, so matches between the crosses themselves are
dropped.

The scan must show the whole frame, centred to within half a grid cell. A frame
scanned in two halves (as some KH-9 archive scans are) is not supported yet.

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
For each scan the dialog lists how many crosses it found, how much film deformation
they measured beyond the scan's placement (µm RMS), and how much is left after the
correction. That remainder is the crosses' own measurement noise, usually a few
micrometres. A cross that disagrees with its neighbours, most often scene texture
taken for a cross, is left out of the correction and counted as an outlier.

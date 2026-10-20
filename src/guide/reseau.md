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

The scan must show the whole frame, centred to within half a grid cell. Frames
scanned in two halves are stitched instead (see **Scans** below).

## Scans
<!-- param: mode  default: Half frames when the scans pair up -->
**Whole frames** measures the crosses on each scan as it is. **Half frames** is for
archives that scan a frame in two overlapping parts, as the KH-9 mapping camera's
frames are: `<frame>_a` is the left of the film and `<frame>_b` the right (`-a` / `-b`
works too). The dialog pairs the scans by name and offers this mode when it finds
pairs.

Each half's crosses are found by growing outward from one cross, so a half needs no
known placement. Every half shows the film's full height, which fixes the rows; the
columns are counted from each half's outer edge. How many columns the two halves
share is decided by the scene: the overlap is compared for every count the crosses
allow, and the one where the halves' images agree is kept. A pair whose halves agree
on no count clearly is reported and left as it is, most often because a half's edge
column of crosses was not found.

Each pair becomes one image, `<frame>.tif`, on the film's own grid: every half is
corrected for its placement and its film deformation, and the two meet in the middle
of the shared columns. Ground control marks on a half move to the stitched frame. The
stitched frames share one new sensor with the certificate's focal length and principal
point and the scan pixel size. Their deformation is already corrected, so they need no
reseau calibration of their own, and self-calibration on **Auto** holds the
certificate values for them too. Stitching reads both halves in full and writes the
frame: about fifteen seconds per hundred megapixels.

Film size is not asked in this mode: the halves' crosses give the lattice.

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
For each scan the dialog lists how many crosses it found, how much film deformation
they measured beyond the scan's placement (µm RMS), and how much is left after the
correction. That remainder is the crosses' own measurement noise, usually a few
micrometres. A cross that disagrees with its neighbours, most often scene texture
taken for a cross, is left out of the correction and counted as an outlier.

For half frames the dialog lists, per frame, the crosses found on each half, the
lattice they make up (columns × rows), how many columns the halves share (hover it for
how well the scenes agreed there, 1 being identical), and the film deformation
measured on each half.

---
id: panoramic
title: Split Panoramic Strips
summary: Cut panoramic (optical-bar) satellite scans, such as KH-9 and KH-4 panoramic frames, into segments that reconstruct as frame cameras.
category: Reconstruction pipeline
order: 17
---
A [panoramic camera](help:panoramic-camera) exposes a long strip of curved film, and
no frame camera describes a whole strip. **Split Panoramic Strips** (Tools → Images ▾
→ Film scans) cuts every scan of a sensor into segments a few degrees of scan wide.
Each segment is resampled exactly into the image a frame camera would have taken,
turned to that part of the scan, at the same focal length and pixel size. The
segments then go through Detect Features, Match Features and Sparse Reconstruction
like any frame images, each with its own pose.

The sensor needs the camera's **focal length in millimetres** (1,524 mm for the KH-9
panoramic camera, 609.6 mm for KH-4 Corona) and the **scan pixel size** (mm per
pixel) in the sensor table. Each scan must show one whole frame, with the scan running
along its long side, and the film's centre line halfway up the scan. Frames that the
archive delivers in several pieces need joining first.

Each strip `<name>.tif` becomes `<name>_s01.tif`, `<name>_s02.tif` and so on, in scan
order. Ground control marks on a strip move to every segment that shows them. All the
segments share one new sensor: the strip's focal length and pixel size, with the
principal point at the segment's centre. Self-calibration on **Auto** holds those
values, since the resampling is exact and a few degrees of field cannot tell the
focal length from the height. Splitting reads each strip once at full resolution and
writes its segments, about as fast as stitching half frames.

The satellite moves several kilometres during one scan, and that is not modelled. On a
synthetic KH-9 panoramic block the split is exact while the satellite stands still:
checkpoints within a fifth of a pixel across, half a pixel in height. With a realistic
scan (half a second at 7.6 km/s, the film shift compensating the motion), the best
pose of a segment at a strip's end still misses by about a pixel, and over a narrow
segment that tilts the block: checkpoints fell to tens of metres across and a few
hundred in height. Treat the result as a first, coarse model of a panoramic block:
enough to register the strips, orient them and find ground control, not yet a
survey-grade DEM.

## Sensor
The sensor whose scans are split. Only sensors with a scan pixel size and a focal
length in millimetres are listed.

## Segments per strip
<!-- param: segments  default: Auto -->
How many segments each strip is cut into. **Auto** cuts it into near-square
segments, one per strip height of scan: about 16 for a KH-9 panoramic frame. More
segments keep each closer to the film, since the satellite moves less while one is
exposed, but each sees less ground and ties to fewer of the others. Fewer, wider
segments do the opposite.

## Overlap
<!-- param: overlapPct  default: 10 % -->
How far each segment reaches into its neighbours, as a percentage of its own share of
the scan, on each side. Neighbouring segments of one strip then share points, which
holds the strip together in the bundle adjustment. 0 cuts the strip edge to edge.

## Remove the strips
<!-- param: removeStrips  default: on -->
Removes each strip from the project once its segments are added, so reconstruction
uses only the segments. Turn it off to keep the strips for viewing, and leave them out
of reconstruction then.

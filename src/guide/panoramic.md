---
id: panoramic
title: Split Panoramic Strips
summary: Cut panoramic (optical-bar) satellite scans, such as KH-9 and KH-4 panoramic frames, into segments that reconstruct as frame cameras.
category: Reconstruction pipeline
order: 17
---
A [panoramic camera](help:panoramic-camera) exposes a long strip of curved film, and
no frame camera describes a whole strip. **Split Panoramic Strips** (Tools ▸ Images ▾
▸ Film scans) cuts every scan of a sensor into segments a few degrees of scan wide.
Each segment is resampled exactly into the image a frame camera would have taken,
turned to that part of the scan, at the same focal length and pixel size. The
segments then go through Detect Features, Match Features and Sparse Reconstruction
like any frame images, each with its own pose.

The sensor needs the camera's **focal length in millimetres** (1,524 mm for the KH-9
panoramic camera, 609.6 mm for KH-4 Corona) and the **scan pixel size** (mm per
pixel) in the sensor table. Each scan must show one whole frame, with the scan running
along its long side, and the film's centre line halfway up the scan. Frames that the
archive delivers in several pieces need joining first.

Each strip `<name>.tif` becomes `<name>_s01.tif`, `<name>_s02.tif` and so on; GCP marks
move to the segments that show them. The segments share a new sensor, whose values
self-calibration on **Auto** holds.

The satellite's motion during a scan is not modelled, so the result is a first, coarse
model of a panoramic block: enough to register and orient the strips and find ground
control, not yet a survey-grade DEM.

## Sensor
The sensor whose scans are split. Only sensors with a scan pixel size and a focal
length in millimetres are listed.

## Segments per strip
<!-- param: segments  default: Auto -->
How many segments each strip is cut into. **Auto** makes near-square segments. More
segments fit the film more closely but each ties to fewer others; fewer do the
opposite.

## Overlap
<!-- param: overlapPct  default: 10 % -->
How far each segment reaches into its neighbours, so they share points that hold the
strip together. 0 cuts edge to edge.

## Remove the strips
<!-- param: removeStrips  default: on -->
Removes each strip from the project once its segments are added, so reconstruction
uses only the segments. Turn it off to keep the strips for viewing, and leave them out
of reconstruction then.

---
id: quality-report
title: Quality Report
summary: Explains what succeeded, where the model is weak, and what to fix before dense processing.
category: Check and troubleshoot
order: 110
---
The Quality Report derives diagnostics from the current project. Use it after matching,
after sparse reconstruction, and again after alignment or dense work. A green overview
is a useful screen, not a guarantee of survey accuracy.

## Overview
Start here for stage health and prerequisites. Grey sections simply mean the required
result has not been built yet. Follow warnings into the detailed section rather than
changing settings blindly.

## Matching
Look for disconnected components, fragile bridge pairs, and images with unusually few
verified matches. A high raw match count is not enough; spatially spread geometric
inliers and a connected capture network matter.

## Sparse and coverage
Registration rate, track length, and reprojection error describe different failure
modes. Long tracks seen in several views are stronger than many two-view points. The
coverage map reveals areas where tie points cluster or disappear.

## Calibration
Inspect focal-length change, principal point, and radial distortion. Large drift or
implausible curves can mean weak camera geometry, mixed sensors, bad matches, or too
many free calibration parameters.

## Accuracy
Residuals for GCPs, camera positions, scale evidence, and reference DEM checks are only
meaningful in their stated units and frame. Look for directional or spatial patterns,
not only the average. Independent checkpoints are stronger evidence than control used
in the fit.

## Dense
Review depth-map completion, valid-pixel fractions, and consistency before fusion.
One weak image is often cheaper to exclude or mask than to make every threshold loose.

## DEM vs reference DEM
**Products** compares the current DEM with an imported reference DEM: ΔZ = DEM −
reference at every DEM cell the reference covers (on a sub-grid for a large DEM).
Median and NMAD describe the bulk, RMSE includes the blunders. When the DEM records
which cells were interpolated (see [DEM ▸ Gap interpolation](guide:dem)), a tile
gives the RMSE of the cells with points and of the interpolated cells apart; the
interpolated ones usually carry most of the large errors.

A DEM in a CRS is also co-registered to the reference (Nuth & Kääb): **Horizontal
offset** says where the DEM sits relative to it, east and north, and **NMAD after
shift** what the spread would be once that offset is gone (slopes 5–45°, where an
offset shows). A large offset with a much smaller NMAD after it means the DEM is a
good surface in the wrong place, not a noisy one: on a slope, a sideways shift reads
as height error. It happens when the control's positions and heights come from
different references, as with Find GCPs (a satellite image for the position, a DEM
for the height). On Rachel Glacier the DEM sat 11 m north of REMA, and its NMAD on
stable rock went from 8.7 m to 5.3 m once shifted.

**Move the control onto the reference** removes such an offset at its source. It moves
every control and check point by the offset (worked out in the DEM's CRS), refills its
height from this reference DEM at the new position, and refits the georeference.
Rebuild the DEM and orthophoto afterwards. Use it when the reference DEM is the
better-located of your references, and do not use it on surveyed control.

## Stable ground
<!-- param: stableArea  default: All cells -->
A polygon layer of ground that has not changed between the two DEMs, such as rock
outcrops, roads or buildings. Only cells inside it are compared. Without it, a
comparison of a historical DEM with a modern one mixes the reconstruction error with
real change: a thinning glacier, an eroded bank or a filled pit. Import the outlines
as a polygon file (**Import**, GeoJSON); the panel says how many DEM cells fell
outside.

## Area
<!-- param: area  default: Whole DEM -->
A polygon layer that limits the comparison to an area of interest, for example a
glacier outline or the study area plus a buffer. It combines with **Stable ground**:
a cell must lie inside both. The margins of a block are usually its weakest part,
so the statistics inside the area of interest can differ a lot from those of the
whole DEM. The exported report names both layers.

## Export report
Export produces a self-contained HTML report with no external assets or scripts. Open
it in a browser and print to PDF if needed. It captures the current state, so export it
after the final reconstruction and alignment.

The report ends with **Methods and references**: each step this project ran (features,
matching, SfM, dense, mesh, DEM, orthophoto, …), how WebSfM did it, and the papers it
follows, with a full reference list. It is meant for the methods section of a paper or
report. Every method WebSfM implements is listed under About ▸ References, and each
glossary entry names its own under *Sources*.

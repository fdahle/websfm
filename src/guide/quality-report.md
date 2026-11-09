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
coverage map reveals areas where tie points cluster or disappear. When images were
added to the model ([Sparse Reconstruction](guide:sparse-reconstruction) ▸ Add to the
model), each run is listed with the images it added and those it could not place.
**Try again…** under the last one opens Sparse Reconstruction to add the photos still
out once more, with looser registration gates filled in (fewer correspondences, a
wider reprojection threshold); check what they place before relying on them.

## Calibration
Inspect focal-length change, principal point, and radial distortion. Large drift or
implausible curves can mean weak camera geometry, mixed sensors, bad matches, or too
many free calibration parameters. The ± after the refined focal is how well the photos
fixed it: heights move by that share of the camera-to-ground distance. It is the
precision the solve gives with its lens model and the accuracies you entered, not a
bound on the error: check points tell you that. A nadir block without camera positions
or GCPs cannot fix the focal at all; add either, or oblique photos.

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

**Horizontal offset** says how far the DEM sits east and north of the reference, and
**NMAD after shift** what the spread would be without it. A large offset with a much
smaller NMAD after it means a good surface in the wrong place: on slopes a sideways
shift reads as height error. It happens when the control's positions and heights come
from different references, as with Find GCPs.

**Co-register DEM…** removes such an offset: it opens
[Co-register DEM](guide:coregister-dem) with this reference and stable ground, which
moves a copy of the DEM, or the georeference, onto the reference.

## Stable ground
<!-- param: stableArea  default: All cells -->
A polygon layer (GeoJSON) of ground unchanged between the two DEMs, such as rock,
roads or buildings; only cells inside it are compared. Without it, comparing a
historical DEM with a modern one mixes reconstruction error with real change.

## Area
<!-- param: area  default: Whole DEM -->
A polygon layer limiting the comparison to an area of interest; a cell must also lie
in **Stable ground**. A block's margins are usually its weakest part, so the figures
inside the area can differ a lot from the whole DEM's.

## Export report
Export produces a self-contained HTML report with no external assets or scripts. Open
it in a browser and print to PDF if needed. It captures the current state, so export it
after the final reconstruction and alignment.

It ends with **Methods and references**: each step the project ran, how, and the papers
it follows, for the methods section of a paper or report. About ▸ References lists every
method WebSfM implements.

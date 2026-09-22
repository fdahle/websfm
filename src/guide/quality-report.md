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

## Export report
Export produces a self-contained HTML report with no external assets or scripts. Open
it in a browser and print to PDF if needed. It captures the current state, so export it
after the final reconstruction and alignment.

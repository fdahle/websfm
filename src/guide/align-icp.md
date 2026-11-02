---
id: align-icp
title: Align to Reference (ICP)
summary: Refine the alignment of a cloud that is already roughly in place onto a reference cloud or mesh, by iterative closest point.
category: Tools
order: 124
---
**Tools ▸ Point Cloud ▾ ▸ Align to reference (ICP)…** moves a cloud onto a reference
cloud or mesh by [ICP](help:icp): it pairs each sampled point with the nearest reference
point, solves the motion that brings the pairs together, and repeats. It refines an
alignment that is already roughly right; for clouds far apart, align them by point pairs
first. The moved cloud is added as a new one; the log gives the RMS, rotation and shift.

## Search radius
<!-- param: maxDistance  default: 0 (auto) -->
Points farther than this from the reference are not paired. **0** uses ten point
spacings. It must be larger than the current misalignment; set it smaller once close,
so that changed areas (new buildings, vegetation) do not pull the result.

## Also fit scale
<!-- param: estimateScale  default: Off -->
Also solves a scale factor, for clouds from different sensors or reconstructions whose
scales differ. Leave it off when both clouds are in true units: a scale is easy to fit
wrongly on flat or one-sided scenes.

## Sample points
<!-- param: sampleCount  default: 50000 -->
How many points of the moving cloud are paired in each iteration. More is steadier and
slower; 20,000–100,000 suits most clouds.

## Iterations
<!-- param: maxIterations  default: 100 -->
The most iterations; the run stops earlier once the points no longer move. Raise it
if the log says it stopped at the limit.

## Point-to-plane
<!-- param: pointToPlane  default: On -->
Measures each pair's distance along the reference's surface normal, which converges
faster and slides along flat areas. It needs a reference with normals; turn it off for
point-to-point, which pins down scale and position better on flat scenes.

---
id: reduce-overlap
title: Reduce Overlap
summary: Disable the photos of a heavily overlapping block that the depth maps do not need, so the dense stages run faster.
category: Dense reconstruction
order: 48
---
**Tools ▸ Images ▾ ▸ Reduce overlap…** picks the photos of the main model that the
[depth maps](guide:depth-maps) actually need and disables the rest. A drone block flown
at 80 % forward and 70 % side overlap sees each spot of the ground in a dozen or more
photos; the depth maps, the dense cloud and the orthophoto then spend most of their
time on photos that add little. Fewer photos make every dense stage faster.

Nothing is deleted. A disabled photo keeps its features, matches and pose, and
**Enable** in the image list brings it back ([Disable photos](guide:getting-started)).
Only enabled photos with a pose take part; photos you disabled yourself stay disabled.
The dialog counts the result as you change a setting, and its button says how many
photos it would disable.

## Before you run
Run it after the sparse model and before [Build Depth Maps](guide:depth-maps). The
sparse model stands in for the surface: up to 10,000 of its points, spread over the
whole model. Where it has no points (water, a featureless roof), no photo is needed
there, so a photo that only sees such places can be disabled; check the result in the
3D view before a long dense run. Use it on blocks with much overlap. On an object
captured in a ring, or a sparse block, little or nothing goes.

## Viewing angle
<!-- param: maxAngle  default: 60 -->
A photo sees a point when the point is in front of it and inside its frame, and the
photo looks at it from within this angle of the direction the point's own photos see
it from (the photos that matched it). That direction is the side of the surface they
face, so on an object a photo of the far side does not count; nothing else tests
occlusion. Lower it (40°) to count only photos that look at a point nearly as its own
do; raise it (80–90°) for oblique photos of a façade from many sides.

## Photos per point
<!-- param: coverage  default: 6 -->
How many photos every point keeps, or all that see it where fewer do. Photos go one at
a time, the one whose points are most over-covered first, while every point keeps at
least this many. On the 347-photo quarry block, 6 kept 145 photos: the depth maps took
a third of the time, and the DEM covered 97.8 % of what all photos give, within 0.17 m
(NMAD). 3 kept 87 photos and a fifth of the time, but the DEM lost a tenth of its
area. Lower it for a quick look, raise it where the surface is hard to match
(vegetation, steep terrain).

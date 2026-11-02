---
id: apriltag
title: AprilTag
aliases: AprilTag, AprilTags, tag36h11, coded target, coded targets
summary: A printed square of black and white cells that carries a number, so software finds it and knows which one it is without help.
refs: olson2011, wang2016
---
An **AprilTag** is a square target: a black ring around a 6 × 6 grid of black and white
cells, inside a white border. The cells spell a code word from a fixed family; in
**tag36h11** 587 code words differ from each other in at least 11 of their 36 cells, so a
reading with a few wrong cells, from blur, glare or a speck of dirt, still gives the
right number, and a random pattern is almost never taken for a tag.

Used as a [GCP](help:ground-control-point) target, a tag needs no model to be found: the
detector looks for dark squares in the whole photo, fits their edges to a fraction of a
pixel and reads the cells through the square's perspective. Its centre is where the
two diagonals cross, the point to survey. Metashape's coded targets and ArUco markers
are the same idea with other code families.

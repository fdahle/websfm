---
id: image-footprint
title: Image Footprint
aliases: image footprint, image footprints, ground footprint, ground footprints, monoplotting
summary: The patch of ground an image covers: its four corners cast from the camera onto the terrain.
---
An image's **footprint** is the outline of the ground it shows. Cast a ray from the
camera through each image corner, using the [camera pose](help:camera-pose) and
[intrinsics](help:camera-intrinsics), and mark where it meets the ground: the four
points bound the footprint. A nadir image over flat ground gives a rectangle; a
tilted one a trapezoid that widens away from the camera.

Where a ray meets the ground depends on what the ground is taken to be. A
horizontal plane is simple but wrong over relief: a footprint over a valley is too
small, and one over a ridge too large. Following a
[DEM](help:digital-elevation-model) instead is **monoplotting**: along each ray,
find the point where the ray drops to the terrain height below it. The camera and
terrain heights must share a [vertical datum](help:vertical-datum), or every
footprint is scaled by the same error.

Footprints are approximate: lens distortion is ignored, and only the corners are
cast, so the edges between them are straight. They are good enough to see coverage and to choose which images can
overlap ([preselection](help:preselection)).

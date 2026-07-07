---
id: orthophoto
title: Orthophoto
aliases: orthophotos, orthomosaic, orthoimage, ortho
summary: A photo corrected so every pixel is viewed straight down at a constant scale, giving a map-accurate, measurable image.
---
An **orthophoto** is an aerial image that has been geometrically corrected so
that it reads like a map: every pixel appears as if viewed from directly above,
at a single uniform scale, with the distortions of perspective and terrain
relief removed. Because the scale is constant, you can measure true distances
and areas directly off the image.

A raw photo cannot do this — objects lean away from the image centre and tall
terrain is displaced — because the camera sees the world in perspective. WebSfM
removes those effects by reprojecting the source photos through the recovered
camera poses and the scene geometry, reusing the cached depth maps as a z-buffer
so that only the surface actually visible in each direction contributes colour.

Orthophoto generation therefore depends on the dense geometry produced by
[Multi-View Stereo](help:multi-view-stereo) and pairs naturally with the
[Digital Elevation Model](help:digital-elevation-model): the DEM stores height,
the orthophoto stores appearance, over the same ground.

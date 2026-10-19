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
camera poses and the scene geometry, reusing the cached
[depth maps](help:depth-map) as a z-buffer so that only the surface actually
visible in each direction contributes colour.

<!-- TODO(image): assets/orthophoto-vs-perspective.svg - a terrain profile with a building, showing the perspective camera's rays making the building lean and displacing a hilltop, next to the parallel top-down rays of the ortho projection, with one occluded facade greyed out to motivate the z-buffer. -->

Most ground is seen by several photos, so an orthophoto is also a **mosaic**: each
area has to come from one of them. WebSfM prefers the photo that looks most nearly
straight down on an area, at the finest ground resolution, so on a flight at one
altitude the ground splits into regions around each photo's nadir point, and the
borders between regions are the **seamlines**. Choosing whole regions rather than
pixel by pixel keeps buildings and trees from leaning differently from one pixel to
the next, and a [graph cut](help:graph-cut) bends the seams around buildings and
trees, where neighbouring photos disagree. Two corrections then hide the seams.
**Colour balance** gives each photo one brightness gain per colour channel, fitted by
least squares so that overlapping photos agree (after Brown & Lowe, 2007).
[Multiband blending](help:multiband-blending) mixes the photos at each seam, fine
detail over a pixel or two and brightness over a wide band. Both work in linear
light, the physical intensity before display gamma.

<!-- TODO(image): assets/ortho-seamlines.svg - nadir points of a 3×3 photo block over the ground, the region each photo is given (Voronoi-like cells), one seam bending around a building, with the blending band either side of it. -->

Where a surface is hidden from every camera, no colour can be recovered — the
orthophoto's holes are an honest map of what the block did not see, and are best
fixed by taking more photos rather than by interpolation.

Orthophoto generation therefore depends on the dense geometry produced by
[Multi-View Stereo](help:multi-view-stereo) and pairs naturally with the
[Digital Elevation Model](help:digital-elevation-model): the DEM stores height,
the orthophoto stores appearance, over the same ground.

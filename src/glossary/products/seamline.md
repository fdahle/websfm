---
id: seamline
title: Seamline
aliases: seamlines, seam line, seam lines, colour balance, color balance, feathering, seam blending
summary: The border in an orthomosaic where the colour switches from one source photo to the next. Mosaicking decides where the seams run, then hides them with colour balance and seam blending.
refs: boykov2001, boykov2004
---
Most ground in an aerial survey is seen by several photos, so an
[orthophoto](help:orthophoto) is a **mosaic**: each area has to come from one of
them. The border where one photo's area meets the next is a **seamline**. Two things
can show there. Geometry: a building that leans one way in one photo and the other
way in the next, or an edge that does not quite line up. And colour: the photos
differ in exposure, vignetting and the angle of the sun.

**Where the seams run.** The simplest choice gives each area to the photo that
looks most nearly straight down on it, at the finest ground resolution. On a flight
at one altitude this splits the ground into regions around each photo's nadir point,
like the cells of a Voronoi diagram, and keeps neighbouring pixels in the same photo,
so buildings and trees lean consistently inside a region. But the borders then run
wherever the midpoints fall, often straight through a roof or a tree, and there the
two photos show it from different sides. WebSfM's default places the seams by
[graph cut](help:graph-cut) instead: each pixel still prefers its most nadir photo,
but every pixel of seam costs the colour difference between the two photos there, so
the seams bend around buildings and trees and follow open ground and roads, where the
photos agree.

<!-- TODO(image): assets/seamlines.svg - the nadir points of a 3 by 3 photo block, the region each photo is given, one nearest-nadir seam cutting through a building next to the graph-cut seam bending around it, and a before and after strip showing the exposure step across that seam removed by colour balance. -->

**Hiding them.** Two corrections work in linear light, the physical intensity before
display gamma:

- **Colour balance** gives each photo one brightness gain per colour channel, fitted
  by least squares so that overlapping photos agree (after Brown & Lowe, 2007). A
  gain far from 1 points at a photo with very different exposure; gains are limited
  to 0.25–4, two stops either way.
- **Seam blending** mixes the two photos at each seam. The default,
  [multiband blending](help:multiband-blending), mixes fine detail over a pixel or
  two and brightness over about a hundred either side, so the seam shows neither a step nor a
  double image. **Feathering** cross-fades the photos over one band either side of
  each seam: a wider band hides larger colour steps, but small misalignments then
  show as a soft double image inside it. A width of 0 gives hard seams.

All of this applies to the **Mosaic** blend, the default. The log reports how visible the
seams are: the colour step across seams compared with the step inside one photo
(×1 means the seams do not show in colour). See
[Build an Orthophoto](guide:orthophoto).

A [textured mesh](help:texture-atlas) has seams for the same reason: neighbouring
triangles that take different photos. There, [view selection](help:view-selection)
keeps them few, and the same per-photo gains level the colours across them.

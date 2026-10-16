---
id: seamline
title: Seamline
aliases: seamlines, seam line, seam lines, seams, colour balance, color balance, feathering, seam blending
summary: The border in an orthomosaic where the colour switches from one source photo to the next. Mosaicking decides where the seams run, then hides them with colour balance and feathering.
---
Most ground in an aerial survey is seen by several photos, so an
[orthophoto](help:orthophoto) is a **mosaic**: each area has to come from one of
them. The border where one photo's area meets the next is a **seamline**. Two things
can show there. Geometry: a building that leans one way in one photo and the other
way in the next, or an edge that does not quite line up. And colour: the photos
differ in exposure, vignetting and the angle of the sun.

**Where the seams run.** WebSfM gives each area to the photo that looks most nearly
straight down on it, at the finest ground resolution. On a flight at one altitude
this splits the ground into regions around each photo's nadir point, like the
cells of a Voronoi diagram. Choosing by viewing angle rather than by image content
keeps neighbouring pixels in the same photo, so buildings and trees lean
consistently, and stray single pixels from another photo are folded into the region
around them.

<!-- TODO(image): assets/seamlines.svg - the nadir points of a 3 by 3 photo block, the region each photo is given, one seam highlighted with the feathering band either side, and a before and after strip showing the exposure step across that seam removed by colour balance. -->

**Hiding them.** Two corrections work in linear light, the physical intensity before
display gamma:

- **Colour balance** gives each photo one brightness gain per colour channel, fitted
  by least squares so that overlapping photos agree (after Brown & Lowe, 2007). A
  gain far from 1 points at a photo with very different exposure; gains are limited
  to 0.5–2.
- **Feathering** cross-fades neighbouring photos over a narrow band either side of
  each seam. A wider band hides larger colour steps, but small misalignments then
  show as a soft double image inside it. A width of 0 gives hard seams.

Both apply to the **Mosaic** blend, the default. The log reports how visible the
seams are: the colour step across seams compared with the step inside one photo
(×1 means the seams do not show in colour). See
[Build an Orthophoto](guide:orthophoto).

---
id: multiband-blending
title: Multiband Blending
aliases: multiband blending, multi-band blending, Laplacian pyramid, Laplacian pyramid blending
summary: Joining two images at a seam band by band, fine detail over a short distance and brightness over a long one, so the seam shows neither a step nor a double image.
refs: burt1983
---
Where two photos meet in a mosaic, a plain cross-fade has to choose one width for
everything. A narrow fade leaves a visible step wherever the photos differ in
brightness; a wide one hides the step, but any detail that does not line up exactly
shows twice, as a soft double image across the whole band.

**Multiband blending** (Burt and Adelson, 1983) splits each photo into frequency
bands with a **Laplacian pyramid**: the photo blurred and halved in size again and
again, each level keeping only the detail the next coarser level lacks. The seam's
mask goes through the same blur. Each band is then mixed with the mask blurred to
its own level: the finest detail switches from one photo to the other within a pixel
or two, so nothing ghosts, while the coarsest band, which carries brightness and
colour casts, fades over a wide distance, so nothing steps. Adding the bands back
together gives the blended image. Away from the seams every pixel keeps its own
photo's colour.

![Two photos of the same ground, one exposed brighter, cut at a seam with a visible step. The image split into three bands, fine detail, medium and coarse brightness, each mixed with its own mask: a sharp step for fine detail, a wide ramp for brightness. The bands added back give an image with no step.](assets/multiband-blending.svg)

In an [orthophoto](help:orthophoto) WebSfM blends in five bands, so the coarsest
fades over about a hundred pixels either side, after per-photo colour balance has already
removed most of the exposure difference. See [Seamline](help:seamline) and
[Build Orthophoto](guide:orthophoto).

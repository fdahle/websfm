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

<!-- TODO(image): assets/multiband-blending.svg - two photos meeting at a vertical seam, split into three bands (fine edges, medium, coarse brightness), each band's blend mask beside it, narrow for the fine band and wide for the coarse one, and the recombined result without a step. -->

In an [orthophoto](help:orthophoto) WebSfM blends in five bands, so the coarsest
fades over about a hundred pixels either side, after per-photo colour balance has already
removed most of the exposure difference. See [Seamline](help:seamline) and
[Build an Orthophoto](guide:orthophoto).

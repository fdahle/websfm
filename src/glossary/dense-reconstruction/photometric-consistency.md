---
id: photometric-consistency
title: Photometric Consistency
aliases: NCC, ZNCC, matching cost, photo-consistency, photometric cost
summary: How well a candidate surface patch, warped into neighbouring views, actually looks the same in all of them — the score dense stereo optimises.
---
**Photometric consistency** is the test at the heart of dense stereo. A candidate
depth at a pixel implies a small surface patch in 3D; warp that patch into each
neighbouring view through the [camera poses](help:camera-pose) and compare it to
what is actually there. If the depth is right, the patches look the same. If it
is wrong, they do not.

The comparison uses **ZNCC** — zero-mean normalised cross-correlation — over a
small window (WebSfM caps the half-window at 5, so 11×11 pixels). Subtracting
each window's mean and normalising by its standard deviation makes the score
invariant to brightness and contrast differences between the two photos, which
matter a great deal across a flight line where exposure and viewing angle both
change. The result runs from +1 (identical) to −1, and it is converted to a cost
that [PatchMatch](help:patchmatch) minimises.

<!-- TODO(image): assets/photometric-cost.svg - a pixel's viewing ray with three candidate depths, each warping a patch into two source views; beside it a cost-versus-depth curve with a sharp minimum for textured surface, and a second flat curve for a textureless region annotated as ambiguous. -->

**Its blind spots define the rest of the pipeline.** ZNCC has nothing to say
about three common cases:

- **Textureless surfaces** — fresh snow, water, a blank wall. Every depth
  correlates about equally well, so the cost curve is flat and the winning depth
  is noise.
- **Repetitive texture** — the cost curve has several equally deep minima and the
  algorithm picks one arbitrarily.
- **Sky and vegetation** — the trap, because these score *well*. Smooth sky
  correlates strongly at literally any depth, and a bush is genuinely
  well-textured. No cost threshold can reject them.

This is why a low matching cost is necessary but never sufficient, and why the
cost gate is followed by **cross-view geometric consistency**: a pixel must
unproject, reproject through a neighbour's *own* depth, and come home to within a
few pixels, in several views independently. Sky and vegetation fail that test
because different views disagree about where they are — which is the only signal
that separates them from real surface.

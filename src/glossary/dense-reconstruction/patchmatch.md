---
id: patchmatch
title: PatchMatch
aliases: patch match, patchmatch stereo, slanted plane
summary: The dense-stereo search that guesses a small oriented surface patch per pixel, then lets good guesses spread to their neighbours instead of testing every depth.
---
**PatchMatch** is how WebSfM builds a [depth map](help:depth-map) without
exhaustively testing every possible depth at every pixel. It rests on one
observation: surfaces are mostly continuous, so a depth that works well at one
pixel almost certainly works well next door. Rather than searching, it
*propagates*.

Each pixel holds a hypothesis — not just a depth, but a small **slanted plane**:
a depth plus a surface normal. That extra orientation is what makes the method
work on real terrain. A fronto-parallel patch assumes the surface faces the
camera squarely, which is wrong for any slope and gets worse the wider the
[baseline](help:baseline); the slanted plane instead induces a proper homography
that warps the patch correctly into each source view before comparison.

The algorithm alternates three steps over several sweeps, on an image pyramid
from coarse to fine:

1. **Initialise** every pixel with a random plane.
2. **Propagate** — offer each pixel its neighbours' planes as candidates.
   Crucially, a neighbour's *plane* is intersected with this pixel's own viewing
   ray to get the candidate depth; copying the neighbour's raw depth instead
   assumes a fronto-parallel world and produces the characteristic "freckled"
   depth map.
3. **Refine** — perturb the current plane by a decaying random amount, keeping
   any improvement.

<!-- TODO(image): assets/patchmatch.svg - a red-black checkerboard sweep pattern over a pixel grid, one pixel receiving candidate planes from its four neighbours, and an inset showing a slanted plane intersected with the pixel's viewing ray to yield the candidate depth (versus the wrong fronto-parallel copy). -->

Candidates are scored by [photometric consistency](help:photometric-consistency)
against several neighbouring views, keeping the best-K sources so that a surface
occluded in one view is not condemned by it.

WebSfM implements the same kernel three times — in Rust/WASM on the CPU, in WGSL
on the GPU, and in JavaScript as the reference — and they must agree: the GPU
path is roughly a thousand times faster per image, so it is validated against the
CPU result on the first image of every run before being trusted for the rest.
The GPU version sweeps in a red-black checkerboard pattern so that propagation
can run in parallel without neighbouring pixels updating each other mid-pass.

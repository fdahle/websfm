---
id: track
title: Track
aliases: tracks, feature track, track length
summary: A set of keypoint observations across multiple images that all correspond to the same 3D tie point.
---
A **track** is the chain of observations of one physical feature across the
image set: keypoint 412 in photo A is matched to keypoint 87 in photo B, which is
matched to keypoint 233 in photo C, and so the three are transitively the *same*
world point. Pairwise matching only ever produces two-image links; assembling
them into tracks is what turns a pile of pairs into one reconstruction.

Each track triangulates to exactly one [Tie Point](help:tie-point), and every
observation in the track contributes one
[reprojection error](help:reprojection-error) residual to
[bundle adjustment](help:bundle-adjustment). So **track length — the number of
images an observation chain spans — is the single best proxy for point quality**.
A 2-image track is the minimum that can be triangulated at all and is exactly as
trustworthy as the weaker of its two matches; a 6-image track is over-determined,
heavily constrained, and pins the cameras that see it.

<!-- TODO(image): assets/track.svg - one world point projecting into four cameras, its four keypoints highlighted, the pairwise match links drawn between consecutive images, and the whole chain bracketed as one track of length 4. -->

Tracks fail in two characteristic ways, and WebSfM repairs both:

- **Split tracks** — the same feature ends up as two separate chains because a
  linking match was missed. Two nearly-coincident tie points result, each with
  half the support. A merge pass rejoins them after bundle adjustment.
- **Corrupt tracks** — a single bad match welds two *different* world points into
  one chain, so the triangulation lands between them and pulls on every camera
  involved. These show up as large residuals and are removed by the track filter.

The track-length histogram in the Quality Report is the fastest read on a
reconstruction's health: a distribution dominated by length-2 tracks means the
[match graph](help:match-graph) is thin and the result is fragile, however good
the average reprojection error looks.

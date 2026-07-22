---
id: homography
title: Homography
aliases: homographies, H matrix, planar homography
summary: A 3×3 projective map between two images that holds when the scene is planar or the camera only rotated — and a warning sign when it explains a pair too well.
---
A **homography** $H$ is a 3×3 projective transformation mapping every point of
one image directly to a point in another: $x' \sim H x$. Unlike the
[fundamental matrix](help:fundamental-matrix), which constrains a match to a
*line*, a homography predicts the match's exact position — a much stronger claim,
valid only in two situations:

- The observed scene is **planar** (a flat field, a façade, distant terrain that
  is effectively flat at the working scale).
- The camera **only rotated** about its own centre, with no translation.

Both cases share a defining property: **there is no parallax**, and therefore no
depth information. This is what makes the homography useful as a *diagnostic* in
Structure from Motion.

<!-- TODO(image): assets/homography-vs-fundamental.svg - left, a planar scene where matches are predicted exactly by H; right, a scene with depth where a point in image 1 only constrains its match to the epipolar line. Below, a pure-rotation pair annotated as zero baseline. -->

When a pair's matches are explained just as well by an $H$ as by an $F$, the pair
is **degenerate**: it has no usable [baseline](help:baseline), so the essential
matrix decomposition is unstable and [triangulation](help:triangulation) from it
is meaningless. WebSfM fits both models and records the ratio of their inlier
counts.

**It records it as a label, never as a gate.** A high H/F ratio marks a pair as a
poor candidate to *initialise* the reconstruction from, and that is all it does —
rejecting such pairs outright would sever perfectly good matches over flat
terrain, which for polar and desert surveys means most of the block. The
distinction matters enough that pairs falling below the hard acceptance floor
skip the H fit entirely: they are rejected on their own merits, and their
meaningless H/F ratio is never read.

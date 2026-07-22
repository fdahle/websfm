---
id: keypoint
title: Keypoint
aliases: keypoints, feature, features, feature point, interest point
summary: A distinctive, repeatably-detectable image location (a corner or blob) used as an anchor for matching between photos.
---
A **keypoint** is a distinctive point in an image — typically a corner or a
blob-like region — that can be detected reliably even when the same scene is
viewed from a different angle, distance, or lighting condition. Keypoints are
the raw material of Structure-from-Motion: everything downstream is built on
finding the *same* physical feature across multiple photos.

WebSfM detects keypoints with **SIFT** (Scale-Invariant Feature Transform),
which finds extrema across image scale so that a feature is recognisable whether
it appears large or small. Each keypoint carries a position, scale, and a
128-dimensional **descriptor** — a compact fingerprint of the surrounding pixels
that lets two keypoints be compared numerically.

<!-- TODO(image): assets/keypoint-matches.svg - two overlapping photos of the same scene side by side, detected keypoints drawn as circles sized by scale with an orientation tick, and a handful of correct matches joined by lines plus one obviously wrong match in a contrasting colour. -->

When a keypoint in one image is paired with a keypoint in another (see
[RANSAC](help:ransac) for how spurious pairs are filtered), the result is a
match. Chaining matches of the same feature across many images forms a
[Track](help:track), and a track that is triangulated in 3D becomes a
[Tie Point](help:tie-point).

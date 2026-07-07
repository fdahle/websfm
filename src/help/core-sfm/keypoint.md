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

When a keypoint in one image is paired with a keypoint in another (see
[RANSAC](help:ransac) for how spurious pairs are filtered), the result is a
match. A keypoint that survives matching and is triangulated in 3D becomes a
[Tie Point](help:tie-point).

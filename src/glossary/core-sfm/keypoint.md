---
id: keypoint
title: Keypoint
aliases: keypoints, feature, features, feature point, interest point
summary: A distinctive, repeatably-detectable image location (a corner or blob) used as an anchor for matching between photos.
refs: lowe2004, detone2018, tyszkiewicz2020, zhao2023, lindenberger2023
---
A **keypoint** is a distinctive point in an image — typically a corner or a
blob-like region — that can be detected reliably even when the same scene is
viewed from a different angle, distance, or lighting condition. Keypoints are
the raw material of Structure-from-Motion: everything downstream is built on
finding the *same* physical feature across multiple photos.

WebSfM detects keypoints with **SIFT** (Scale-Invariant Feature Transform) by
default, which finds extrema across image scale so that a feature is recognisable
whether it appears large or small. The learned detectors ALIKED, DISK and
SuperPoint are the alternatives, for matching with LightGlue. Each keypoint carries
a position and a **descriptor** (128 numbers for SIFT, DISK and ALIKED, 256 for
SuperPoint) — a compact fingerprint of the surrounding pixels that lets two
keypoints be compared numerically.

![Two overlapping photos of the same scene, keypoints drawn as gold circles sized by scale with an orientation tick, green lines joining correct matches between the photos and one red dashed line joining a house corner to a rock: a wrong match.](assets/keypoint-matches.svg)

When a keypoint in one image is paired with a keypoint in another (see
[RANSAC](help:ransac) for how spurious pairs are filtered), the result is a
match. Chaining matches of the same feature across many images forms a
[Track](help:track), and a track that is triangulated in 3D becomes a
[Tie Point](help:tie-point).

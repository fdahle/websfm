---
id: descriptor
title: Descriptor
aliases: descriptors, feature descriptor, SIFT descriptor
summary: A fixed-length vector summarising the image patch around a keypoint, compared across images to find matches.
---
A **descriptor** is the numeric fingerprint of the pixels surrounding a
[Keypoint](help:keypoint). Detection answers *where* an interesting point is;
the descriptor answers *what it looks like*, in a form two images can be
compared through. Without it, matching would have to compare raw pixel patches —
which fails the moment the second photo is rotated, closer, or differently lit.

A descriptor is built to be stable under exactly those changes. [SIFT](help:sift)
takes the patch at the keypoint's own scale, rotates it to the patch's dominant
gradient orientation, and accumulates gradient directions into a 4×4 grid of
8-bin histograms — 128 numbers, normalised so that a uniform brightness or
contrast change leaves them unmoved. Two descriptors are then compared by plain
Euclidean distance: small distance, similar appearance.

<!-- TODO(image): assets/sift-descriptor.svg - one keypoint patch rotated to its dominant orientation, the 4x4 cell grid over it, and one cell expanded into its 8-bin gradient histogram, with the 4x4x8 = 128 arithmetic called out. -->

**Descriptor width is per-detector, not a universal constant.** WebSfM ships two
detectors: SIFT at 128 dimensions and SuperPoint (a learned detector) at 256.
The width travels with the descriptors through matching, because slicing a flat
descriptor buffer at the wrong width silently produces nonsense rows rather than
an error.

Nearest-neighbour distance alone is a weak test — a repetitive façade offers many
near-equal candidates — so matching accepts a pair only if the best match is
clearly better than the second best (the [Lowe ratio test](help:lowe-ratio-test)),
and the surviving pairs are then checked geometrically with
[RANSAC](help:ransac).

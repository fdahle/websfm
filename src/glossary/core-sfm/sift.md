---
id: sift
title: SIFT
aliases: scale-invariant feature transform
summary: Scale-Invariant Feature Transform — the detector/descriptor that finds keypoints and their 128-d descriptors.
refs: lowe2004, arandjelovic2012
---
**SIFT** (Scale-Invariant Feature Transform) is the classic feature detector and
descriptor, and WebSfM's default. Its defining property is in the name: it finds
the same physical feature whether it appears large or small in the frame, which
is what lets photos taken from different distances be matched at all.

It works on a **scale space** — the image blurred by progressively larger
Gaussians, stacked into octaves that halve in resolution. Subtracting adjacent
blur levels gives a Difference-of-Gaussian (DoG) pyramid, a cheap approximation
of a blob detector. A [Keypoint](help:keypoint) is a point that is a local
extremum in the DoG pyramid across *both* image position and scale, refined to
sub-pixel accuracy; the scale at which it fired becomes the keypoint's own
scale, and that is what makes the subsequent [Descriptor](help:descriptor)
scale-invariant.

![Left, the Gaussian scale space: one photo blurred more and more, in two octaves, the second at half the size. Middle, the differences of adjacent blur levels, where blob-like structure lights up red or blue at its own scale. Right, three stacked 3×3 grids for the scale above, this scale and the scale below: the centre cell is a keypoint when it is larger or smaller than all 26 neighbours.](assets/sift-scale-space.svg)

Two filters keep the output honest. Low-contrast extrema are discarded, and
extrema lying along an edge — where the position is well-determined across the
edge but slides freely along it — are rejected by an edge-response test. WebSfM
adds a third: one strong blob can fire as an extremum on several adjacent
scales, producing a cluster of index-distinct keypoints within a couple of
pixels, so near-duplicate positions are suppressed at detection time.

The tunable that matters most in practice is the **contrast threshold**: lower it
to get more keypoints on flat, low-texture surfaces such as snow and ice, raise
it to keep only strong, well-localised features. An image that finds fewer than half
the keypoint cap is detected again at half the threshold automatically. Detection resolution is the
other lever — SIFT cost scales with pixel count, and downscaling large scans
before detection is usually the cheapest speed-up available.

---
id: sift
title: SIFT
aliases: scale-invariant feature transform
summary: Scale-Invariant Feature Transform — the detector/descriptor that finds keypoints and their 128-d descriptors.
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

<!-- TODO(image): assets/sift-scale-space.svg - the octave/blur-level pyramid on the left, the DoG stack obtained by subtracting adjacent levels in the middle, and the 3x3x3 neighbourhood extremum test on the right. -->

Two filters keep the output honest. Low-contrast extrema are discarded, and
extrema lying along an edge — where the position is well-determined across the
edge but slides freely along it — are rejected by an edge-response test. WebSfM
adds a third: one strong blob can fire as an extremum on several adjacent
scales, producing a cluster of index-distinct keypoints within a couple of
pixels, so near-duplicate positions are suppressed at detection time.

The tunable that matters most in practice is the **contrast threshold**: lower it
to get more keypoints on flat, low-texture surfaces such as snow and ice, raise
it to keep only strong, well-localised features. Detection resolution is the
other lever — SIFT cost scales with pixel count, and downscaling large scans
before detection is usually the cheapest speed-up available.

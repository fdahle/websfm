---
id: lowe-ratio-test
title: Lowe Ratio Test
aliases: ratio test, ratio threshold, nearest-neighbour ratio, cross-check, mutual nearest neighbour
summary: Accept a descriptor match only if the best candidate is clearly better than the second best — a distinctiveness test, not a similarity test.
---
The **Lowe ratio test** is the standard filter applied to descriptor matching. For
a [keypoint](help:keypoint) in image A, find the two nearest
[descriptors](help:descriptor) in image B and compare their distances:

$$\frac{d_1}{d_2} < \tau \quad \Rightarrow \quad \text{accept}$$

The insight is that **absolute distance is a bad criterion and relative distance
is a good one**. A small $d_1$ only means the patches look alike; plenty of
image patches look alike. What matters is whether the best candidate is
*distinctively* better than its nearest rival. If the second-best match is nearly
as close, the feature is ambiguous — one window in a row of identical windows,
one ripple in a snowfield — and picking the closer of two indistinguishable
options is a coin flip.

<!-- TODO(image): assets/lowe-ratio.svg - a query descriptor with its two nearest neighbours in descriptor space shown twice: a distinctive case where d1 is much smaller than d2 (accepted), and an ambiguous case on a repetitive facade where d1 is approximately d2 (rejected), with the corresponding image patches beside each. -->

The threshold $\tau$ is the main quality/quantity dial in matching:

- **Lower (≈0.6–0.7)** — strict. Fewer matches, but a much higher proportion
  correct. The right default, and the right direction to move when a
  reconstruction is contaminated by false pairs.
- **Higher (≈0.8–0.9)** — permissive. More matches on repetitive or low-texture
  surfaces, at the cost of letting ambiguous ones through for
  [RANSAC](help:ransac) to sort out. Worth trying when the
  [match graph](help:match-graph) is too sparse to connect.

A complementary filter is **cross-check** (mutual nearest neighbour): keep a
match only if A's best candidate in B also has A's keypoint as *its* best
candidate back. It is cheap, catches a different class of error than the ratio
test — the many-to-one collapse where a dozen features in A all claim the same
feature in B — and the two are usually enabled together.

Neither test knows any geometry. Both are appearance-only prefilters whose job is
to hand a manageable, mostly-correct set of candidates to the geometric
verification stage, where the [fundamental matrix](help:fundamental-matrix) has
the final say.

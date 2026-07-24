---
id: matching-density
title: Matching Density
aliases: match density, fast matching, full matching, tiled matching
summary: How many correspondences a matcher tries to find per image pair — a trade of speed against the number of tie points, most visible in the "Fast" vs "Full" choice on the learned matcher.
---
**Matching density** is the number of correspondences a matcher attempts to
recover between two images, relative to how many [keypoints](help:keypoint) each
image holds. A denser match returns more [tie points](help:tie-point) — more
evidence for [bundle adjustment](help:bundle-adjustment) and a fuller
[point cloud](help:point-cloud) — but costs proportionally more time and memory.

The trade-off is sharpest on the learned matcher (LightGlue). Its attention
mechanism is $O(N^2)$ in the keypoint count $N$, so it cannot simply be handed
every keypoint of a high-resolution image. WebSfM exposes the trade as two modes:

- **Fast** caps each image at a fixed keypoint budget (a few thousand) and runs
  one matching pass. The cap is applied by [descriptor](help:descriptor) strength,
  so the strongest features survive — enough to register most datasets quickly.
- **Full (tiled)** matches coarsely first, then splits each image into a grid of
  tiles and matches the tiles within the attention budget, recovering
  correspondences the flat cap would have thrown away. It is slower but denser,
  and it is what recovers fine structure on large scans where a few thousand
  keypoints spread across the whole frame leave gaps.

<!-- TODO(image): assets/matching-density.svg - the same image pair matched twice, side by side. Left (Fast): a sparse scatter of correspondence lines concentrated on the strongest corners. Right (Full/tiled): a much denser field of lines covering the whole overlap, with a faint tile grid overlaid to show where the extra matches came from. -->

Density is not free quality. Every extra correspondence is another chance for a
wrong match, so matching always feeds [geometric verification](help:ransac) — a
[fundamental-matrix](help:fundamental-matrix) fit that keeps only the
correspondences consistent with a single camera motion. A denser raw match with
the same verification simply lands more *verified* pairs; it does not lower the
bar for what counts as a match. The right density is therefore a resource
decision — how much time to spend for how many tie points — not a correctness
one.

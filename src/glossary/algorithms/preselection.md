---
id: preselection
title: Pair Preselection
aliases: preselection, pair preselection, preselect, pair selection
summary: Choosing which image pairs to match before matching them, so an N-image set costs far less than comparing every pair — using camera positions, ground footprints, or capture order.
---
Matching every image against every other is $O(N^2)$ pairs, and most of those
pairs share no view at all — two photos from opposite ends of a survey have
nothing to match. **Preselection** is the step that decides *which* pairs are
worth matching before paying to match them, turning a quadratic cost into
something close to linear on large sets.

WebSfM preselects three ways, in decreasing order of how much prior knowledge
each needs:

- **By camera position.** When [camera poses](help:camera-pose) or EXIF GPS are
  available, keep only each image's $k$ nearest neighbours by camera centre. A
  short [baseline](help:baseline) is a necessary (not sufficient) condition for
  overlap, so this prunes almost all the non-overlapping pairs for free.
- **By ground footprint.** With poses *and* a ground height, project each image's
  footprint onto the ground and keep pairs whose footprints overlap by more than a
  threshold — a tighter test than distance alone, since it accounts for where each
  camera is actually looking.
- **By capture order.** With no poses at all, a set whose filenames form a
  sequence (a flight strip, video frames) can match each image only to the next
  few in order, optionally closing the loop back to the start. This is the
  no-metadata fallback.

<!-- TODO(image): assets/preselection.svg - a grid of image thumbnails with the full N-by-N pair matrix faded in the background, and the sparse subset of actually-matched pairs highlighted: a narrow band near the diagonal for sequential, plus a few off-diagonal cells for loop closures. -->

When none of these apply — an unordered set with no positions — matching stays
**exhaustive**, and a cheaper *subset gate* does the pruning instead: it matches a
small, spatially-uniform sample of each pair's [keypoints](help:keypoint) first
and skips the full match when too few survive. That keeps exhaustive *coverage*
(a loop closure anywhere in the [match graph](help:match-graph) is still found) at
a fraction of the per-pair cost. Preselection and the subset gate are therefore
complementary: the first avoids starting hopeless pairs when priors exist, the
second bails out of them quickly when they don't.

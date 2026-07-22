---
id: ransac
title: RANSAC
aliases: random sample consensus, MSAC
summary: A robust algorithm that fits a geometric model to data full of outliers by finding the model the most points agree with.
---
**RANSAC** (Random Sample Consensus) is a robust estimation algorithm used
throughout WebSfM to fit a clean geometric model to data that is contaminated
with outliers.

Feature matching is never perfect — repetitive texture or similar-looking
patches cause some [Keypoints](help:keypoint) to be paired incorrectly. RANSAC
copes by working iteratively:

1. Pick a small random subset of the matches — just enough to define a model.
2. Fit a geometric model to that subset (for example the fundamental matrix
   relating two views, or a camera pose).
3. Count how many of the *other* matches agree with the model within a pixel
   tolerance — these are the **inliers**.
4. Repeat many times and keep the model with the most inliers.

<!-- TODO(image): assets/ransac.svg - a 2D scatter with a clear linear trend plus scattered outliers, showing a least-squares fit dragged off by the outliers versus the RANSAC fit with its inlier band drawn, and one sampled minimal subset circled. -->

Matches that disagree with the winning model are discarded as outliers, so a
handful of bad correspondences can't skew the reconstruction. WebSfM applies
this idea in two places: verifying pairwise matches via the fundamental matrix
during [Epipolar Geometry](help:epipolar-geometry) checking, and estimating each
camera's pose during registration (using MSAC, a variant that scores inliers by
how well they fit rather than a hard in/out count).

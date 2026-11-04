---
id: import-features
title: Import Keypoints & Matches
summary: Reads keypoints and matches from text or CSV files written by another detector or matcher, checks the matches geometrically, and makes them this project's features.
category: Reconstruction pipeline
order: 14
---
**Import ▸ Keypoints & Matches** reads the features another tool found, so the sparse
model can be built from them: a learned matcher run outside the browser, matches checked
by hand, or keypoints from a detector WebSfM does not have. Load the photos first, then
pick one or more `.txt`, `.csv` or `.key` files. The dialog shows how many images,
keypoints, pairs and matches it found, and what to import.

## Keypoints
Pixel positions with the origin at the image's top-left corner, as COLMAP writes them:
a table with `image,x,y` columns (scale and orientation optional), one file per image
named after it (`IMG_0001.txt` with `x y` rows), or Lowe's SIFT `.key` files as Bundler
and VisualSFM use. Importing replaces an image's keypoints and removes its matches. The
files carry no descriptors, so Match Features cannot match these images: import their
matches too.

## Matches
Three layouts: COLMAP's match list (a line with two image names, then one `indexA
indexB` line per match, a blank line before the next pair); a table `imageA, imageB,
indexA, indexB`; or matched points by position, `imageA, xA, yA, imageB, xB, yB`, for a
matcher that writes no keypoints. Then the matched points become the keypoints. An
index refers to the keypoints imported with it, or to the image's own when the files
give it none.

## Verify geometrically
On by default: each pair is checked as Match Features checks its own (a fundamental
matrix by RANSAC, at its default thresholds), and only the inliers are kept; a pair
that fails is left out. Turn it off only for matches another tool has already verified:
then every match is taken as correct.

<!--
  Help entry schema (documented once here, applies to every file in src/help/):

  ---
  id: kebab-case-id       # required, must match the filename (without .md)
  title: Display Title    # required, shown as the panel/tooltip heading
  summary: One or two sentences shown in the hover tooltip. Keep it short.
  ---
  Markdown body shown in the full panel when the term is clicked.
  Link to another entry with [label](help:other-entry-id) — clicking it
  pushes that entry onto the panel stack instead of navigating away.
-->
---
id: reprojection-error
title: Reprojection Error
summary: The pixel distance between a 3D point projected through a camera and the 2D keypoint it was actually observed at.
---

Reprojection error is the residual that camera pose estimation and
[bundle adjustment](help:bundle-adjustment) try to minimize: take a 3D point,
project it through a camera's pose and intrinsics, and measure the distance
in pixels between that projection and the keypoint it was matched from.

A lower threshold during PnP RANSAC is stricter — fewer correspondences pass
as inliers, but the ones that do are better localized. Typical values are
1-4 px depending on image resolution and keypoint precision.

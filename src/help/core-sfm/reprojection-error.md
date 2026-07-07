<!--
  Glossary entry schema (documented once here, applies to every file in src/help/):

  ---
  id: kebab-case-id       # required, must match the filename (without .md)
  title: Display Title    # required, shown as the tab/tooltip heading; also an auto-link alias
  summary: One or two sentences shown in the hover tooltip. Keep it short.
  aliases: extra phrase, another one   # optional; extra words that auto-link to this entry
  ---
  Markdown body shown in the full modal tab when the term is opened.
  - Link explicitly with [label](help:other-entry-id) — opens/focuses that tab.
  - Any occurrence of another entry's title/alias auto-links; to suppress a
    specific one, wrap it: <span class="no-help">bundle adjustment</span>.
  - Math: $inline$ and $$block$$ via KaTeX. Images: ![alt](assets/foo.png)
    (files under src/help/assets/). Standard markdown otherwise.
-->
---
id: reprojection-error
title: Reprojection Error
summary: The pixel distance between a 3D point projected through a camera and the 2D keypoint it was actually observed at.
aliases: reprojection errors
---

Reprojection error is the residual that camera pose estimation and
[bundle adjustment](help:bundle-adjustment) try to minimize: take a 3D
[tie point](help:tie-point), project it through a camera's pose and
[intrinsics](help:camera-intrinsics), and measure the distance in pixels between
that projection and the [keypoint](help:keypoint) it was matched from. A low
reprojection error means the recovered geometry is self-consistent — the cameras
and the 3D structure genuinely agree on where each feature is.

It is the common currency of quality across the pipeline. Pose estimation and
bundle adjustment minimise it; [RANSAC](help:ransac) uses it as the inlier test
that separates good correspondences from outliers. A lower threshold during PnP
RANSAC is stricter — fewer correspondences pass as inliers, but the ones that do
are better localized. Typical values are 1–4 px depending on image resolution and
keypoint precision.

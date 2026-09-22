---
id: detect-features
title: Detect Features
summary: Finds distinctive points in every image—the raw material used to connect views.
category: Reconstruction pipeline
order: 20
---
Detection finds repeatable [keypoint](help:keypoint)s and describes their local image
appearance. More keypoints can help difficult imagery, but they also make matching
slower and do not compensate for blur, poor overlap, or repeated texture.

## Detector
**SIFT** is the dependable default and works entirely in WASM. **SuperPoint** is a
learned detector intended to be paired with LightGlue; its model is downloaded once
with your permission and cached locally. Do not mix SIFT and SuperPoint descriptors
in one run—use **Overwrite** when switching detector.

## Quality preset
Start with **Balanced**. Choose **Detailed** for high-resolution aerial or film scans
when small texture matters, and **Fast** for a first-pass check. Higher resolution and
keypoint limits increase the cost of the following matching stage, often more than
the cost of detection itself.

## Resolution rule
**Fixed for all images** gives every image the same longest-side detection size.
**Scale with image size** preserves more detail in unusually large or mixed-resolution
sets while keeping the selected value as a floor. Keypoints are always mapped back to
native image coordinates.

## Contrast threshold
<!-- param: contrastThreshold default: 0.01 -->
SIFT only. Lower values retain weaker features and may help snow, ice, or low-contrast
scans; higher values keep fewer, stronger features. If raising the keypoint cap changes
nothing, the contrast threshold may be the limiting gate.

## Max keypoints
<!-- param: maxKeypoints default: 10000 (SIFT) · 2048 (SuperPoint) -->
The per-image cap after ranking by strength. Raise it when useful detail is visibly
underrepresented. SuperPoint stays lower because LightGlue's attention cost grows
quickly with the number of keypoints.

## Tiling
Tiling detects overlapping pieces near native resolution and merges duplicates at
their seams. Use **Auto** for very large scans, small important detail, or SuperPoint
inputs that exceed the single-pass limit. Manual tile size is mainly a memory control;
overlap prevents features at tile edges from being clipped.

## Append or overwrite
**Append** skips images that already have completed detection. **Overwrite** replaces
all keypoints and invalidates results that depend on them. Use Overwrite after changing
detector, or when you need a clean comparison of detection settings.

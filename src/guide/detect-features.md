---
id: detect-features
title: Detect Features
summary: Finds distinctive points in every image—the raw material used to connect views.
category: Reconstruction pipeline
order: 20
---
Detection finds repeatable [keypoint](help:keypoint)s in each image and describes the
image around them. More keypoints help difficult images but make matching slower, and
they can't make up for blur, poor overlap or repeated texture. SIFT descriptors are
stored as RootSIFT, as in COLMAP.

## Only some images
Right-click images ▸ **Detect features…** detects only those images again; their old
keypoints and matches are replaced, and every other image keeps its own. If the sparse
model holds one of them, rebuild the model afterwards.

## How the settings fit together
Detection runs four steps, in the order of the dialog's numbered steps: **Resize**
each image to the detection resolution (never enlarged), **Tile** the resized image if
tiling is on, **Detect**, and **Keep** the strongest keypoints up to the limit. The line
under the quality cards shows them for the largest image; click a step there (or
**⚙ more** on a step) for its settings and what it does to your images.

## Detector
<!-- param: detector  default: SIFT -->
**SIFT** is the dependable default and needs no download. **ALIKED**, **DISK** and
**SuperPoint** are learned detectors paired with LightGlue matching; they can do better
across large changes in viewpoint, season or sensor. ALIKED (BSD) and DISK (Apache)
download once with your permission; ALIKED is about four times faster. SuperPoint's
weights are for non-commercial research only, so you supply `superpoint.onnx`
yourself. Don't mix detectors in one project: use **Overwrite** when switching.

## Quality preset
<!-- param: preset  default: Balanced -->
Start with **Balanced**. **Detailed** suits high-resolution aerial images and film scans
where small texture matters; **Fast** is a first check. Higher settings cost more in
matching than in detection.

## Resolution rule
<!-- param: maxDimMode  default: Fixed for all images -->
**Fixed for all images** detects every image at the same long side. **Scale with image
size** detects each at a share of its own size, with the set value as the floor: more
detail for large or mixed-resolution sets. For SIFT the keypoint limit then grows with
the area too.

## Detection resolution
<!-- param: maxDim  default: 2400 px (SIFT) · 1600 px (SuperPoint) · 1024 px (DISK, ALIKED) -->
The long side, in pixels, each image is reduced to before detection. Higher finds finer
texture on large scans, at more cost in detection and matching. Raise it for film scans
and large aerial frames; lower it for a quick pass. DISK and ALIKED need far more memory
per pixel, so they start lower.

## Contrast threshold
<!-- param: contrastThreshold default: 0.01 -->
SIFT only. Lower keeps weaker features, which helps snow, ice and low-contrast scans;
higher keeps fewer, stronger ones. If raising Max keypoints changes nothing, this
threshold is what limits the count.

## Retry faint images
<!-- param: faintRetry  default: On -->
SIFT only, untiled. An image that finds fewer than half the keypoint limit is detected
again at half the contrast threshold. It adds features only where they are missing
(interiors, plain walls, uniform fields), and costs matching time where it does. Turn
it off to detect every image once.

## Max keypoints
<!-- param: maxKeypoints default: 10000 (SIFT) · 2048 (SuperPoint, DISK, ALIKED) -->
The keypoint limit per image. SIFT keeps the largest features first, as COLMAP does,
since they survive viewpoint changes best. Raise it when many images log exactly the
limit; there is no upper bound, and the field says what a large value costs in
matching. The learned detectors keep their best-scoring points; their default stays
lower because LightGlue's time grows with its square.

## Tiling
<!-- param: tiling  default: Off -->
Detects overlapping tiles of the **resized** image, so it saves memory but never adds
resolution: raise the detection resolution for that. Use it when a learned detector's
input is too large for one pass, or a high resolution makes one pass too large for
memory. **Auto** picks the tile size (for learned detectors, what fits the GPU);
**Manual** uses Max tile size.

## Max tile size
<!-- param: tileSize  default: 1024 -->
**Manual** tiling: the largest tile; WebSfM uses the fewest tiles that fit. Lower it
only if a learned detector still runs out of GPU memory.

## Tile overlap
<!-- param: overlap  default: 64 -->
How far tiles overlap, in resized pixels. Each tile keeps only features away from its
edges, so none is cut. 64 px suits SIFT; raise it only if tiled runs match worse.

## Mode
<!-- param: overwrite  default: Append -->
**Append** skips images already detected. **Overwrite** detects all again and replaces
their keypoints and the results built on them: use it after changing the detector or
settings.

## Batch throughput
SIFT spreads images over every worker the memory budget (Settings ▸ Compute) allows;
very large images run one at a time. The log reports how many ran in parallel. Cancel
stops new work and discards unfinished results.

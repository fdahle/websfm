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

SIFT descriptors are stored as **RootSIFT**, COLMAP's default form, which tells
similar-looking texture apart better. Projects detected before this change keep
working: their descriptors are converted when matching loads them, so you do not need
to detect again.

## How the settings fit together
Detection runs four steps in a fixed order, and the dialog's Advanced settings are
laid out in that order:

1. **Resize** — each image is reduced so its long side is at most the detection
   resolution. Smaller images are never enlarged.
2. **Tile** — if tiling is on and the *resized* image is larger than one tile, it is
   cut into overlapping tiles. Tiling never adds resolution: to detect a large scan in
   more detail, raise the detection resolution; tiling then keeps memory in bounds.
3. **Detect** — SIFT or the learned detector runs on each tile (or once).
4. **Keep** — the strongest keypoints are kept, up to the per-image limit, ranked over
   the whole image across all tiles.

The strip under the quality cards shows these steps for the largest image the run will
touch, for example `10,137×9,600 native → 2,400×2,273 resized → 2×2 tiles → SIFT → ≤ 10,000
keypoints`. Each step in Advanced settings also says what it does to your images. A step
that has no effect, such as tiling when the resized image already fits in one tile, is
shown greyed with the reason.

## Detector
<!-- param: detector  default: SIFT -->
The detector decides which [keypoint](help:keypoint)s are found in each image and how
each one's surroundings are encoded as a [descriptor](help:descriptor), which is what
matching compares. **SIFT** is the dependable default and works entirely in WASM.
**ALIKED**, **DISK** and **SuperPoint** are learned detectors meant to be paired with
LightGlue matching; each has its own LightGlue, and WebSfM picks the right one
automatically. Do not mix detectors in one project—use **Overwrite** when switching
detector.

**ALIKED** is freely licensed (BSD-3-Clause; its LightGlue is Apache-2.0). It places
keypoints with sub-pixel precision and describes each one by sampling the image at
learned offsets around it. Its model is downloaded once with your permission, like
DISK's. Like DISK, it detects at 1024 px by default, because it needs much more memory
per pixel than SuperPoint. It detects about four times faster than DISK. On a 128-image
building set at the defaults, DISK put all 128 photos into one model, while ALIKED put
120 into one model and 9 into a second.

**DISK** is freely licensed (Apache-2.0). Its model is downloaded once with your
permission and cached in the browser. It detects at a lower resolution than
SuperPoint (1024 px by default), because it needs much more memory per pixel.

**SuperPoint**'s pretrained weights are licensed for **non-commercial research only**,
so WebSfM does not ship them. The first time you run it, the download dialog shows the
license and a direct link: download `superpoint.onnx` from its publisher, then choose
or drop that file in the dialog. It is cached like any other model, and detection
continues on its own. Use ALIKED or DISK if your work is commercial.

## Quality preset
<!-- param: preset  default: Balanced -->
Start with **Balanced**. Choose **Detailed** for high-resolution aerial or film scans
when small texture matters, and **Fast** for a first-pass check. Higher resolution and
keypoint limits increase the cost of the following matching stage, often more than
the cost of detection itself.

## Resolution rule
<!-- param: maxDimMode  default: Fixed for all images -->
**Fixed for all images** gives every image the same longest-side detection size.
**Scale with image size** preserves more detail in unusually large or mixed-resolution
sets while keeping the selected value as a floor. For SIFT it also raises the keypoint
limit with the detected area (see *Max keypoints*). Keypoints are always mapped back to
native image coordinates.

## Detection resolution
<!-- param: maxDim  default: 2400 px (SIFT) · 1600 px (SuperPoint) · 1024 px (DISK, ALIKED) -->
The long side, in pixels, that each image is reduced to before detection (step 1
above); smaller images are never enlarged. A higher value finds finer texture and more
keypoints on large scans, but detection cost grows with the pixel count, and the extra
keypoints make matching slower again. Raise it for film scans or aerial frames whose fine
texture is lost at the default; lower it for a quick first pass. DISK and ALIKED start
lower than SuperPoint because they need far more memory per pixel.

With **Scale with image size** the field is called *Minimum resolution*: each image is
detected at a fraction of its own long side (40 % with Balanced SIFT), never below this
value and never above a ceiling set by the quality preset (4000 px with Balanced SIFT).
Matching's [RANSAC](help:ransac) threshold is measured in detection pixels, so it follows
whatever resolution you choose here.

## Contrast threshold
<!-- param: contrastThreshold default: 0.01 -->
SIFT only. Lower values retain weaker features and may help snow, ice, or low-contrast
scans; higher values keep fewer, stronger features. On textured images the keypoint cap
binds first and the threshold changes little; on low-texture ones (interiors, large
aerial frames detected at reduced resolution) it decides how many features exist. If
raising the keypoint cap changes nothing, the contrast threshold is the limiting gate.
An image that finds fewer than half the keypoint cap at this threshold is detected
again at half the threshold and keeps the larger set; its log line says *faint …
detected again*. This only adds features where they are missing (interiors, plain
walls, uniform fields), so a textured set is detected once, as before.

## Max keypoints
<!-- param: maxKeypoints default: 10000 (SIFT) · 2048 (SuperPoint, DISK, ALIKED) -->
The per-image keypoint limit. When SIFT finds more than this, it keeps the
**largest-scale** features first and drops the finest ones, the same rule COLMAP uses.
Large features survive changes of viewpoint better than fine texture, so at a fixed
limit this gives more points that appear in three or more images (about 10 % more on a
building set detected at full resolution). Raise the limit when useful detail is visibly
underrepresented. The learned detectors keep their highest-scoring points and stay lower,
because LightGlue's attention cost grows quickly with the number of keypoints. ALIKED
finds at most 8,192 keypoints per image or tile, the highest limit the dialog allows.

With **Scale with image size**, the SIFT limit grows with the detected area: the
limit × (detected pixels ÷ 2400 × 1600), never below the configured limit and at
most 4× it (40,000 at the default). A 4000 × 2667 px detection gets about 28,000.
Each image's effective limit is logged. The learned detectors keep their fixed limit.

If many images report exactly the limit in the console, the limit is cutting off
usable features: raising it added about 10 % reconstructed points on a 128-image
building set. Each SIFT keypoint has one orientation; a feature is not duplicated for
a second, weaker orientation, because on real data that cost matching time without
adding points.

## Tiling
<!-- param: tiling  default: Off -->
Tiling detects overlapping pieces of the **resized** image (step 2 above), so it only
does something when the detection resolution is larger than one tile. Each piece keeps
only the features in its own central region, so every feature is found exactly once and
never right at a cut. Use **Auto** for learned-detector inputs that exceed the
single-pass limit, or when a high detection resolution makes one pass too large for
memory. For SIFT, tiling gives the same keypoints
and matches as an untiled run (99.5 % identical on a building pair) and uses less
memory, so it is safe to turn on for large images.

**Auto** picks the tile size for you: 1536 px for SIFT, and for a learned detector the
largest tile that fits the GPU's memory. **Manual** uses the *Max tile size* you enter.

## Max tile size
<!-- param: tileSize  default: 1024 -->
Shown with **Manual** tiling. It is an upper limit: WebSfM uses the fewest tiles that fit
the resized image, shrunk to the smallest size that still keeps the requested overlap.
Smaller tiles use less memory per pass but mean more passes and more overlap work; lower
it only if a learned detector still runs out of GPU memory at the Auto size.

## Tile overlap
<!-- param: overlap  default: 64 -->
How far neighbouring tiles overlap, in pixels of the resized image. Each tile keeps only
the features at least half the overlap away from a cut, so a feature whose
neighbourhood is cut by a tile edge is found in the neighbouring tile instead. The
default 64 px is enough for SIFT on photos; raise it only if a tiled run matches
noticeably worse than an untiled one. A larger overlap costs a little more detection
time.

## Mode
<!-- param: overwrite  default: Append -->
**Append** skips images that already have completed detection. **Overwrite** replaces
all keypoints and invalidates results that depend on them. Use Overwrite after changing
detector, or when you need a clean comparison of detection settings.

## Batch throughput
SIFT batches use every worker of the pool, as many as your configured worker count and
a conservative estimate of image decode and pyramid memory allow; together they must fit
the memory budget in Settings ▸ Compute (the same one dense reconstruction uses).
Large scans or images with unknown dimensions run one at a time. The learned detectors stay
serial to share their model session. The console reports concurrency and batch wall time; Cancel stops
new work and discards unfinished results.

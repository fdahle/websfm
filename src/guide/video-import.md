---
id: video-import
title: Import Video
summary: Turns a video into a set of overlapping, sharp frames — picked by camera motion or at a fixed interval — that reconstruct like photos.
category: Reconstruction pipeline
order: 10
---
**Import → Video** (or dropping a video on the sidebar) extracts frames and adds them
as images. A slow phone video around an object or along a façade is often the easiest
set to reconstruct, since consecutive frames overlap.

The dialog plans the frames first and marks them on a strip under the plan; **Extract**
then saves them at full size (frames saved before a **Cancel** stay). Frames are named
after the video and their time, and all frames of a video share one
[sensor](help:sensor) whose focal length [self-calibration](help:self-calibration)
solves. Don't zoom while filming.

## Frame selection
<!-- param: mode  default: Automatic -->
**Automatic** ([keyframe selection](help:keyframe-selection)) scans the video for
sharpness and camera movement, then spaces frames by movement: one frame while the
camera stands still, many during a fast pan, the sharpest in each step. **Fixed
interval** takes a frame every N seconds or frames: predictable, but with duplicates in
pauses, gaps in fast motion and no blur check.

## Every
<!-- param: every  default: 1 -->
**Fixed interval**: the step between frames, in seconds or frames. For a walk at normal
speed, 0.5–1 s is a good start.

## Overlap
<!-- param: overlap  default: 80 -->
**Automatic**: how much of the view consecutive frames share. At 80 % each part of the
scene is in about five frames, which Sequential matching needs. Raise it for little
texture or quick turns; lower it for a long, slow video.

## Max frames
<!-- param: maxFrames  default: 200 -->
**Automatic**: the most frames to extract; the spacing widens to fit, and the plan shows
the overlap reached. Every later step grows with the image count.

## Blurry below
<!-- param: minSharpness  default: 0.5 -->
**Automatic**: frames less sharp than this share of the nearby median
[sharpness](help:image-sharpness) are avoided in favour of a sharper neighbour. In a
stretch that is all blurry, the sharpest is kept anyway so the sequence stays linked.
**0** allows every frame.

## Format
<!-- param: format  default: JPEG -->
**JPEG** at high quality is the usual choice; **PNG** is lossless but several times
larger.

## JPEG quality
<!-- param: jpegQuality  default: 0.95 -->
0.5–1. From 0.9 up, the fine texture [feature detection](guide:detect-features) needs
is kept.

## Max size
<!-- param: maxDim  default: 0 -->
The long side of saved frames in pixels; 0 keeps the video's size. Mainly saves storage
for 4K video.

## Which videos open
The browser decodes the video. **Chrome and Edge** open MP4 (H.264, AV1), WebM (VP8,
VP9, AV1) and H.265 with a hardware decoder; **Firefox** MP4 and WebM but usually not
H.265; **Safari** MP4 and MOV (H.264, H.265) and WebM. If a video doesn't open, convert
it to H.264 MP4 (`ffmpeg -i in.mov -c:v libx264 -crf 18 out.mp4`).

## After the import
Frames are listed in time order. [Match Features](guide:match-features) then starts on
**Sequential** pairing; turn on **Close capture loop** when the video ends where it
started.

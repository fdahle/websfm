---
id: video-import
title: Import Video
summary: Turns a video into a set of overlapping, sharp frames — picked by camera motion or at a fixed interval — that reconstruct like photos.
category: Reconstruction pipeline
order: 10
---
**Import → Video** (or dropping a video file on the sidebar) extracts frames from a
video and adds them to the project as ordinary images. A slow walk around an object
or along a façade, filmed with a phone, is often the easiest way to get a set that
reconstructs: consecutive frames overlap by construction.

The dialog opens the video in the browser's own player, reads its size, length and
frame rate, and plans the frames *before* anything is written: it shows how many
frames it will extract, and a strip under the plan marks where they fall in the
video. **Extract** then reads only those frames at full size, saves each one into the
project as an image file, and shows progress with a **Cancel** button. Frames already
added when you cancel stay in the project.

Each frame is named after the video and its time in it, for example
`walk_00m12.345s.jpg`, and its metadata records the source video and the frame time
(see the image's info panel, *Video frame*). All frames of one video share one
[sensor](help:sensor). A video carries no focal length, so the sensor starts from the
usual guess (a field of view about as wide as the frame) and
[self-calibration](help:self-calibration) refines it during
[Sparse Reconstruction](guide:sparse-reconstruction). Avoid zooming while filming:
all frames are assumed to share one focal length.

## Frame selection
<!-- param: mode  default: Automatic -->
**Automatic** picks frames by [keyframe selection](help:keyframe-selection): the
video is first scanned a few times a second (a long video more sparsely, at most
3,000 moments), and each moment gets a sharpness score and an estimate of how far
the view has moved since the start. Frames are then spaced by that movement, not by
time: while the camera stands still you get one frame, during a fast pan many, and
within each step the sharpest frame is taken. The scan starts as soon as the dialog
opens; **Stop scan** ends it. Changing the settings below then re-plans instantly
from the scan.

**Fixed interval** takes a frame every N seconds or every N frames, whatever the
camera does. It needs no scan, and it is predictable, but it extracts duplicates
during pauses, skips ahead during fast motion and does not avoid blurry frames.

## Every
<!-- param: every  default: 1 -->
**Fixed interval** only: the step between frames, in seconds or in frames of the
video, starting with the first frame. Counting in frames needs the frame rate, which
the dialog measures by playing the first moments of the video; where the browser
cannot report it, 30 fps is assumed and the dialog says so. For a walk at normal
speed, one frame every 0.5–1 s is a reasonable start.

## Overlap
<!-- param: overlap  default: 80 -->
**Automatic** only: how much of the view two consecutive frames should share, as a
percentage of the frame width. At 80 % the view moves by a fifth of the frame
between frames, so each part of the scene is seen in about five of them, which is
what [Match Features](guide:match-features) needs to link the sequence with its
Sequential pairing. Raise it for a scene with little texture or a camera that turns
quickly; lower it for a long, slow video that would otherwise give hundreds of
near-identical frames. The movement is estimated from the image alone, so the
overlap is approximate: a camera moving towards the scene, for example, changes the
view less than a pan of the same distance.

## Max frames
<!-- param: maxFrames  default: 200 -->
**Automatic** only: an upper limit on the number of frames. When the requested
overlap would give more, the spacing widens until the frames fit, and the plan shows
the overlap actually reached. Matching, reconstruction and depth maps all grow with
the number of images, so a cap keeps a long video practical in the browser.

## Blurry below
<!-- param: minSharpness  default: 0.5 -->
**Automatic** only: a frame is avoided when its [sharpness](help:image-sharpness) is
below this fraction of the median sharpness of the moments around it (about eight
seconds of video), so a dim or soft video is judged against itself. The sharpest
frame in each step is used instead, even when that is a little earlier or later.
When every frame of a stretch is blurry (a fast turn), the sharpest of them is kept
anyway, because a soft frame still links the sequence while a missing one can split
it; the plan says how often that happened. The strip marks the blurry moments red.
**0** makes every frame eligible.

## Format
<!-- param: format  default: JPEG -->
How the frames are stored. **JPEG** at high quality is the usual choice: the video
was already compressed, so a second, light compression adds almost nothing. **PNG**
stores the decoded frame without further loss but is several times larger.

## JPEG quality
<!-- param: jpegQuality  default: 0.95 -->
JPEG only: the encoder quality, from 0.5 to 1. Values from 0.9 up keep the fine
texture [feature detection](guide:detect-features) relies on.

## Max size
<!-- param: maxDim  default: 0 -->
The long side of the saved frames in pixels, or 0 for the video's own size. Frames
are scaled down evenly when the video is larger. Detection reduces large images
anyway, so this mainly saves storage, for example for a 4K video.

## Which videos open
The video is decoded by the browser, so what opens depends on the browser and, for
some codecs, the computer:

- **Chrome and Edge**: MP4 with H.264 or AV1, WebM with VP8, VP9 or AV1, and H.265
  (HEVC) where the system has a hardware decoder (most recent Macs and Windows PCs).
- **Firefox**: MP4 with H.264 or AV1, WebM with VP8, VP9 or AV1; H.265 usually not.
- **Safari**: MP4 and MOV with H.264 or H.265, and WebM with VP8 or VP9.

Phone videos are usually H.264 or H.265 in an MP4 or MOV file. When a video does not
open, the dialog says so; converting it to H.264 MP4 (for example
`ffmpeg -i in.mov -c:v libx264 -crf 18 out.mp4`) makes it readable everywhere.

## After the import
The frames appear in the image list in time order, which is the capture order
Sequential matching uses. When most images in the project are video frames,
[Match Features](guide:match-features) starts on **Sequential** pairing and
recommends it; any other choice you make stands. Turn on **Close capture loop** there
when the video returns to where it started, such as a full walk around an object.

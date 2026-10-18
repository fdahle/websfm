---
id: keyframe-selection
title: Keyframe Selection
aliases: keyframe selection, keyframes, video frame selection
summary: Choosing which frames of a video to reconstruct from — spaced by how far the view moves, sharp, and few enough to stay practical.
---
A video has 25–60 frames a second, far more than a reconstruction needs or can
afford: neighbouring frames are almost identical, so matching them adds cost but no
geometry, and their tiny [baseline](help:baseline) triangulates poorly. **Keyframe
selection** keeps a subset that still overlaps enough to link up, while dropping the
redundant and the blurry frames.

**Spacing by motion, not by time.** A fixed interval extracts duplicates while the
camera pauses and leaves gaps when it turns quickly. WebSfM instead estimates how
far the view has moved: each scanned frame is reduced to a small grey image and
compared with an earlier reference frame in a 3×3 grid of blocks, and each block's
shift is found by trying offsets and keeping the one with the smallest difference
(coarse to fine, over a small image pyramid). The median block shift, as a fraction
of the frame width, is the travel since the reference. A pan moves every block; a
roll or a move towards the scene moves the outer ones. This is a cheap stand-in for
optical flow: it needs no features and runs in a few milliseconds per frame.

The reference frame moves on only after the view has travelled a few percent of
the frame, so slow drift still adds up and a still camera's noise does not. A frame
that no longer resembles its reference (a cut, or motion too fast to follow) counts
as a full frame of travel.

**Choosing frames.** With a target overlap of 80 %, a new frame is due after every
fifth of a frame width of travel. Each keyframe is the sharpest frame between half a
step and a full step after the previous one, so the overlap never falls below the
target while blur can be dodged. [Sharpness](help:image-sharpness) is compared with
the median of the nearby moments, not with a fixed number, because a dim or
low-texture stretch of video is soft throughout.

**Why overlap matters.** Each point of the scene should appear in several frames:
two views give a point, more views give a well-measured one and keep a long sequence
from breaking into pieces. Sequential matching
([pair preselection](help:preselection) by capture order) then matches each keyframe
with the next few, which fits frames chosen this way.

In WebSfM this is the **Automatic** mode of **Import → Video**; see
[Import Video](guide:video-import).

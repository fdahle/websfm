---
id: image-mask
title: Image Mask
aliases: image masks, mask, masks, masked, masking
summary: A per-image overlay marking pixels to ignore, such as sky, the operator or a film border, so feature detection and dense matching skip them.
---
Some pixels in a photo should never take part in a reconstruction: the sky, moving
water, people and cars that moved between shots, the operator's shadow, a drone's
landing gear, the turntable under an object, or the film border, fiducial frame and
scanner background of a scanned aerial photo. They give no stable surface, or worse,
a false one. An **image mask** marks them.

In WebSfM a mask marks the pixels to **exclude**, drawn in red over the image;
everything unmasked is used. A mask acts on:

- **Feature detection.** [Keypoints](help:keypoint) in masked areas are dropped
  before the per-image keypoint limit applies, so a masked film border does not use
  up the keypoint budget.
- **Depth maps and the dense cloud.** Masked pixels get no depth, so nothing from
  them reaches the [dense cloud](help:point-cloud). Masked areas of the neighbouring
  images are also kept out of the matching, so a high-contrast border cannot produce
  false matches.
- **Image quality.** [Sharpness](help:image-sharpness) and exposure are scored on the
  unmasked pixels only.

A mask takes effect the next time a stage runs. Changing a mask does not alter
results that already exist, so rerun detection, or the dense stages, afterwards.

<!-- TODO(image): assets/image-mask.svg - a drone photo with the sky and a landing leg painted red, the detected keypoints shown only on the unmasked ground, and the same photo's depth map with the masked areas empty. -->

**Making masks.** In the image viewer, paint with a brush, erase, draw rectangles, or
use **Smart Select**: click an object and a segmentation model (SAM2) outlines it.
An image file can be imported as a mask: with transparency, its opaque or bright
pixels become excluded; without (a JPEG, a black-and-white PNG), its black pixels do,
as in Metashape and COLMAP.
The **Mask Manager** applies one mask to every image of the same size at once, for an
obstruction fixed in the camera's view. **Auto Mask** excludes a border of a set
width on each side, for film scans, and fiducial detection can mask the scanner
background outside the detected film frame. A mask is two-dimensional and belongs to
one image; to limit the dense stages to a part of the scene in 3D, use a
[Region](guide:model-tools) instead.

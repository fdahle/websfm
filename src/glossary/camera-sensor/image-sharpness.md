---
id: image-sharpness
title: Image Sharpness
aliases: blur score, Laplacian variance, variance of the Laplacian, motion blur, blurry images
summary: A score for how much fine detail an image holds, the variance of its Laplacian. Blurry photos are found by comparing each image's score with the rest of the batch.
---
Blur costs a reconstruction silently: fewer [keypoints](help:keypoint), weaker
matches, thin or patchy dense coverage, and never an error message. The usual
causes are motion blur from a drone moving during the exposure, missed focus, and a
shallow depth of field. It is hard to spot in thumbnails, which is why it is worth
measuring.

**Measuring it.** Blur removes the high frequencies of an image: the sharp edges
and fine texture. The **Laplacian**, a 3×3 second-derivative filter, responds only
to such rapid changes, so the spread (variance) of its response over the image drops
steadily as blur grows. That variance is the sharpness score:

$$\nabla^2 I = \begin{bmatrix} 0 & 1 & 0 \\ 1 & -4 & 1 \\ 0 & 1 & 0 \end{bmatrix} * I, \qquad \text{sharpness} = \operatorname{Var}(\nabla^2 I)$$

**Only relative values mean anything.** The raw number depends on the scene as much
as on the focus: a sharp photo of a snowfield scores below a slightly soft photo of
a city. So WebSfM never compares it with a fixed threshold. It ranks each image
against the **median of the batch**: a photo half as sharp as the typical one in
the same flight is suspicious, whatever the absolute numbers. The score also depends
on resolution, because the Laplacian works per pixel, so every image is first
resampled to the same analysis size (1,024 px on the long side). Cameras of
different resolution are then comparable.

<!-- TODO(image): assets/image-sharpness.svg - the same image patch sharp and motion-blurred, each with its Laplacian response beside it, and a histogram of Laplacian values that is wide for the sharp patch and narrow for the blurred one. -->

In WebSfM, **Tools ▸ Images ▸ Image quality** scores every image. Pixels under an
[image mask](help:image-mask) are left out, so the edge of a mask cannot read as
detail. Images below **Blurry below** (0.5 × the median by default) are flagged, as
are images with more than a quarter of their pixels crushed black or blown white.
Flagged images can be put in a group for review or removed. A photo sharp in only one
corner (shallow depth of field) may still be flagged, so check it before removing it.
See [Image Quality, Region and Orientation](guide:model-tools).

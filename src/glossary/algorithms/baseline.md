---
id: baseline
title: Baseline
aliases: stereo baseline, baselines
summary: The distance between two camera centres; a wider baseline gives a stronger triangulation angle and more reliable depth.
---
The **baseline** is the straight line between two camera centres — how far the
camera moved between the two photos. It is also one leg of the triangle used in
[triangulation](help:triangulation), and its length controls how well-conditioned
that triangle is.

The quantity that actually matters is the **triangulation angle** (or parallax):
the angle at which the two viewing rays meet at the scene point. It grows with
baseline and shrinks with distance to the scene, roughly
$\theta \approx b / Z$ for baseline $b$ and depth $Z$. Depth precision degrades
as $1/\theta$, so a pair with a narrow angle turns a one-pixel keypoint error
into a large depth error, and at zero parallax — two photos from the same spot —
depth is not observable at all.

<!-- TODO(image): assets/baseline-parallax.svg - two side-by-side triangulation diagrams sharing a scene point: a wide baseline with rays crossing sharply and a small uncertainty ellipse, and a narrow baseline with near-parallel rays and a long ellipse smeared along the viewing direction. -->

That makes baseline a two-sided trade-off, and it is why an image pair can be
unusable in either direction:

- **Too short** — plenty of matches (the views look almost identical) but rays
  that are nearly parallel. Triangulation is ill-conditioned, and the pair is a
  poor choice to initialise a reconstruction from.
- **Too long** — a strong angle, but the two views no longer look alike: the
  surface is foreshortened differently, occlusions differ, and matching finds
  too few [keypoints](help:keypoint) in common.

WebSfM uses this on both ends of the pipeline. Picking the initial pair
deliberately favours wide parallax alongside a high inlier count, because the
whole reconstruction inherits that pair's conditioning. In dense matching the
same trade-off returns as source-view selection, and fused points are rejected
outright when the widest angle among their agreeing views is too narrow — the
gate that removes sky, which is "seen" by every camera at effectively zero
parallax.

---
id: geometric-consistency
title: Geometric Consistency
aliases: cross-view consistency, cross-view geometric consistency, cross-view check, geometric consistency filter, forward-backward reprojection
summary: The check that other views confirm a pixel's depth. Project the pixel into a neighbour, read that view's own depth, project back, and see whether you land where you started.
refs: schonberger2016b
---
A depth that only one image believes is a guess. **Geometric consistency** asks the
other cameras to confirm it. It does not compare colours, which
[photometric consistency](help:photometric-consistency) already did. It compares
*geometry*: does each view's own [depth map](help:depth-map) put the surface in the
same place?

The test is a round trip. Take a pixel of the reference image and its depth:

1. Unproject it to the 3D point that depth implies.
2. Project that point into a neighbouring view and read the neighbour's *own* depth
   at the pixel it lands on.
3. Unproject the neighbour's depth to 3D and project that point back into the
   reference image.

If both depth maps describe the same surface, the trip ends within a pixel or so of
where it started (a small forward-backward reprojection error). If the neighbour is
looking at something else there, such as an occluder or noise, it ends far away and
that view does not vouch for the pixel. A pixel is kept only when enough views vouch
for it independently.

<!-- TODO(image): assets/geometric-consistency.svg - a reference camera and a neighbouring camera above a surface; a surface pixel whose round trip (reference pixel to 3D point, into the neighbour, back through the neighbour's own depth) closes on itself, beside a sky pixel whose round trip ends far from where it started. -->

This is the filter that removes sky and vegetation. Both score well photometrically:
a bush matches itself because it is genuinely textured, and smooth sky matches at
any depth. They give themselves away only because different views disagree about
where they are. One caveat: a view taken from almost the same spot looks along
almost the same ray, so it agrees with *any* depth on that ray. Only views that see
the point from at least a minimum angle apart may vote.

WebSfM applies the check twice. In [Depth Maps](guide:depth-maps) it runs as its own
pass once every map exists: a view agrees when the round trip closes within 1 px, a
pixel needs 2 agreeing views, and a view only counts at 3° of parallax or more.
Rejected pixels are erased from the stored maps themselves, so the orthophoto, which
reuses the depth maps for visibility, is cleaned as well. The log's "Depth filter"
lines say how many pixels failed for disagreement and how many for too little
parallax. [Fusion](guide:dense-cloud) checks agreement again as it merges the maps:
a sample is kept when enough maps agree on its depth within the depth agreement
tolerance (1 % of the depth by default), seen from at least 2° apart.

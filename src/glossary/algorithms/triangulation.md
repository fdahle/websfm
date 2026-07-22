---
id: triangulation
title: Triangulation
aliases: triangulate, triangulated, triangulating
summary: Intersecting the viewing rays of two or more posed cameras to recover the 3D position of the feature they both saw.
---
**Triangulation** recovers a 3D point from its 2D observations once the cameras
are posed. Each observation back-projects to a ray from that camera centre
through that pixel; the world point is where the rays meet.

In practice they never quite meet. Keypoint positions carry noise, so the rays
pass near each other rather than intersecting, and the answer is the point that
minimises the disagreement. WebSfM solves the linear (DLT) form first — stack the
constraints $x \times PX = 0$ from every view and take the smallest singular
vector — then, where accuracy matters, refines it with Gauss–Newton against the
true nonlinear criterion, the sum of squared
[reprojection errors](help:reprojection-error). The linear answer minimises an
algebraic quantity that is convenient rather than meaningful; the refinement is
what makes it the geometrically best point.

<!-- TODO(image): assets/triangulation.svg - two camera centres with rays through their respective keypoints not quite meeting, the midpoint of the shortest segment between them marked, and an uncertainty ellipse elongated along the viewing direction; a third camera's ray added to show how the ellipse tightens. -->

Two things decide whether the result is trustworthy:

- **The [triangulation angle](help:baseline).** Rays that meet at a sharp angle
  pin the point down; near-parallel rays leave it free to slide along the
  viewing direction, and a one-pixel error becomes metres of depth error.
  WebSfM refuses to triangulate below a minimum angle rather than emit a point
  it cannot defend.
- **[Cheirality](help:cheirality).** The algebra happily returns points behind
  the cameras. A point must have positive depth in every view that observed it.

Triangulation runs at several points in the pipeline: creating new
[tie points](help:tie-point) as each camera registers, re-triangulating existing
ones after [bundle adjustment](help:bundle-adjustment) has improved the poses
(better poses mean previously failed points now succeed), and placing a
[GCP](help:ground-control-point) into the reconstruction's frame from its
marked observations.

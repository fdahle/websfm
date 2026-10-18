---
id: icp
title: ICP (Iterative Closest Point)
aliases: ICP, iterative closest point, point-to-plane, point-to-plane ICP, point-to-point ICP
summary: Refines the alignment of one point cloud onto another by pairing each point with its nearest neighbour, solving for the transform that brings the pairs together, and repeating.
---
**Iterative Closest Point** aligns two overlapping scans of the same scene without
knowing which point corresponds to which. It guesses: pair every point of the
moving cloud with the nearest point of the reference, solve for the rotation and
shift that best bring those pairs together, apply it, and pair again. Each round
the pairs get better, and the clouds slide into place.

That "nearest" is also its limit. ICP is a **refinement**, not a search: it moves
towards whichever fit is closest to where the clouds start. Two clouds metres apart,
or turned by a large angle, pair the wrong points and settle on a wrong answer that
looks just as converged. A rough alignment has to come first: picked point pairs, a
manual transform, or [georeferencing](help:georeferencing) both clouds.

**Point-to-point or point-to-plane.** The classic form minimises the distance
between paired points. But two scans sample a surface at different spots, so even
perfectly aligned clouds leave a residual of about one point spacing, and the solve
keeps tugging the cloud along the surface. **Point-to-plane** measures each pair's
distance along the reference's [surface normal](help:surface-normal) instead:
sliding along a flat wall costs nothing, only moving off it does. It needs
far fewer iterations than point-to-point, often a few where point-to-point needs
dozens (on a noisy dense cloud, a few tens against a hundred or more), but it needs
normals on the reference.

<!-- TODO(image): assets/icp-point-to-plane.svg - two offset, differently sampled copies of one curved surface; left, point-to-point pairs pulling sideways along the surface; right, point-to-plane residuals measured along the reference normals; below, the moving cloud over three iterations. -->

In WebSfM (**Tools ▸ Point Cloud ▸ Align to reference**) each iteration takes a
fixed random sample of the moving cloud (50,000 points by default) and pairs every
sample point with its exact nearest neighbour in the reference. Pairs farther apart
than the **search radius** are ignored (auto: ten point spacings, so it must exceed
the current misalignment), and of the rest only the closest 90 % are used, so an
area that changed between the clouds, or appears in only one of them, does not drag
the fit. A mesh reference uses its vertices with area-weighted vertex normals; a
reference cloud without normals falls back to point-to-point, and the log says so.
**Also fit scale** adds a scale factor, for clouds from different instruments or
reconstructions. The solve stops when the sample no longer moves, or after 100
iterations; the log reports the RMS distance, the rotation and the shift, and the
aligned copy is added as a new cloud. See
[Point Cloud Tools](guide:point-cloud-tools).

---
id: tie-point
title: Tie Point
aliases: tie points, sparse point, 3D point
summary: A 3D point in the sparse cloud, triangulated from the same physical feature seen in two or more images.
---
A **tie point** is a 3D coordinate produced during the sparse phase of
Structure-from-Motion. Its name comes from its role: it "ties" overlapping
images together into one consistent reconstruction.

When the same [Keypoint](help:keypoint) is matched across two or more images, and
the cameras' poses are known, WebSfM triangulates the point's position in 3D
space — the place where the viewing rays from each camera intersect (subject to a
[Cheirality](help:cheirality) check so it lands in front of the cameras). Every
such point observed in several images forms a **track**.

Collectively the tie points make up the **sparse point cloud**, the skeleton of
the scene. They serve two jobs at once: they anchor the relative geometry of the
cameras, and, together with the observations feeding them, they let
[Bundle Adjustment](help:bundle-adjustment) jointly refine the poses, the 3D
structure, and the [Camera Intrinsics](help:camera-intrinsics) by minimising
[Reprojection Error](help:reprojection-error). They are also the seed that
[Multi-View Stereo](help:multi-view-stereo) later densifies.

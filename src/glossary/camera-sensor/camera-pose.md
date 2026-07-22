---
id: camera-pose
title: Camera Pose
aliases: pose, poses, camera poses, extrinsics, exterior orientation
summary: Where a camera was and which way it pointed — the rotation and translation that map world coordinates into that camera's frame.
---
A **camera pose** (the *extrinsics*, or *exterior orientation* in photogrammetry)
is the camera's placement in the world: six numbers, three for position and three
for orientation. Together with the [camera intrinsics](help:camera-intrinsics) —
the *interior* orientation — it is everything needed to project a world point
into that image. Recovering the poses of all the images is what
[Structure from Motion](help:structure-from-motion) is for.

WebSfM stores a pose in the **OpenCV convention**, as a rotation $R$ and
translation $t$ that map a world point into the camera frame:

$$X_{\text{cam}} = R\,X_{\text{world}} + t$$

Two consequences of that choice are worth memorising, because they are the
single most common source of interop bugs:

- $t$ is **not** the camera position. The camera centre is $C = -R^{\top} t$.
- The camera looks down **+z**, with image **+y pointing down**. Other
  ecosystems differ — OpenGL-style formats (nerfstudio, 3DGS) want a
  camera-to-world matrix looking down −z with +y up, which is why every export
  that crosses that boundary does the axis flip in exactly one documented place.

<!-- TODO(image): assets/camera-pose.svg - a world axis triad and a camera drawn with its own axis triad, the rotation R and translation t annotated as the mapping between them, and the camera centre C = -R^T t marked distinctly from the vector t to make the difference explicit. -->

Poses arrive in a project two ways. They can be **estimated** by the
reconstruction — the initial pair from the [essential matrix](help:essential-matrix),
every later camera by [PnP resection](help:pnp), and all of them jointly polished
by [bundle adjustment](help:bundle-adjustment). Or they can be **imported**,
from a flight log or GNSS/INS record; imported poses are not used as ground truth
for the solve, but they are valuable twice over — to preselect which image pairs
are worth matching, and afterwards as the reference for
[georeferencing](help:georeferencing) the finished reconstruction.

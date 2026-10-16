---
id: cloud-distance
title: Cloud-to-Cloud Distance
aliases: cloud-to-mesh distance, C2C, C2M, signed distance, distance to reference
summary: Each point's distance to a reference cloud or mesh, optionally signed above or below. The standard way to compare two surveys of the same scene.
---
To see what changed between two surveys (erosion, a growing stockpile, progress on a
building site), or how far a reconstruction is from a reference model, give every
point of one cloud its distance to the other and colour the cloud by it. Differences
that are invisible in the raw points stand out at once.

There are two kinds of reference:

- **Cloud-to-cloud (C2C)**: the distance to the *nearest reference point*. It is
  simple, but a cloud is only samples of a surface. Even where the two surfaces
  coincide, a point usually falls between the reference's samples, so the result has
  a floor that grows with the reference's point spacing.
- **Cloud-to-mesh (C2M)**: the exact distance to the *nearest triangle* of a
  [mesh](help:mesh). There is no sampling floor, so a mesh is the better reference
  when you have one.

**Signed or unsigned.** A plain distance says how far, not on which side. A
**signed distance** is positive on the side the reference's
[surface normal](help:surface-normal) points to and negative behind it, which for
terrain means above or below: fill or cut. A mesh always has a side (from the
winding of its triangles); a reference cloud has one only if it carries normals.

**Align first.** The distance measures misalignment as well as real change: a
10 cm shift between two epochs reads as 10 cm of change everywhere. Align the clouds
on parts of the scene that did not change, for example with [ICP](help:icp), before
measuring.

<!-- TODO(image): assets/cloud-distance.svg - a reference surface in profile with points of a second epoch above and below it, nearest-point distances to a sparse reference cloud on one side, exact distances to a mesh on the other, and the points coloured blue to white to red by signed distance. -->

In WebSfM, **Tools ▸ Measure ▸ Distance to reference** measures a dense cloud
against another cloud (exact nearest neighbour) or a mesh (exact point-to-triangle).
The result is a new copy of the cloud carrying a `distance` attribute, coloured
blue → white → red around zero. Points beyond **Ignore beyond** get no value and show
grey. The distance is saved with the project, can be recoloured in the symbology
dialog, and is written to PLY and LAS exports as a scalar field. See
[Point Cloud Tools](guide:point-cloud-tools).

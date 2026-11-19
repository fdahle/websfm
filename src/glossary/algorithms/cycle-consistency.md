---
id: cycle-consistency
title: Cycle Consistency
aliases: cycle consistency filter, rotation cycle, rotation-cycle filter, loop consistency
summary: A check that relative rotations around any loop of three images compose back to the identity. WebSfM once used it to catch false pairs that pass geometric verification; it was removed because it dropped mostly true pairs.
---
**Cycle consistency** exploits a fact about closed loops: if you compose the
relative orientations around a cycle of cameras and return to where you started,
the total rotation must be the identity. Walk from image $i$ to $j$ to $k$ and
back to $i$, and the product of the three relative rotations
$R_{ik}^{-1}\,R_{jk}\,R_{ij}$ should be a no-op. When it is not, one of the three
pairwise estimates is wrong.

This matters because [geometric verification](help:ransac) is not proof. A
[fundamental-matrix](help:fundamental-matrix) fit on a **repetitive** scene — a
brick façade, a row of identical windows — can find a large, self-consistent set
of inliers that describes a plausible but *false* camera motion. Every count- and
ratio-based gate passes; the pair looks healthy in isolation. Only when its
relative rotation is checked against the rest of the [match graph](help:match-graph)
does the contradiction show up.

![Two triangles of cameras i, j, k joined by relative rotations R_ij, R_jk and R_ik. Left, composing them around the loop returns to i's own heading: a check mark. Right, the composed rotation comes back turned away from it, a residual turn, and the wrong pair's edge is drawn red.](assets/cycle-consistency.svg)

The test is only as good as the pairwise rotations it composes, and that is the
catch. Each one comes from decomposing a pair's essential matrix, which needs a
correct [focal length](help:focal-length) and enough non-planar structure. When
either is missing, a **true** pair carries a wrong rotation and fails its
triangles. In practice such a filter removes mostly true pairs, so WebSfM doesn't
use one: false pairs are stopped later, by the
[PnP](help:pnp) registration gates, the track filter and the robust
[bundle adjustment](help:bundle-adjustment).

---
id: cycle-consistency
title: Cycle Consistency
aliases: cycle consistency filter, rotation cycle, rotation-cycle filter, loop consistency
summary: A check that relative rotations around any loop of three images compose back to the identity — used to catch false matches that pass geometric verification but are still wrong.
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

<!-- TODO(image): assets/cycle-consistency.svg - three camera icons i, j, k at the corners of a triangle with directed edges labelled R_ij, R_jk, R_ik. A consistent triangle shows the composed rotation returning to identity (a small check mark at i); an inconsistent one shows a residual rotation arrow at i, and the offending edge highlighted for removal. -->

WebSfM runs this as a filter before reconstruction: every triangle in the graph
votes on its edges, and the edge that fails the most of its triangles is dropped,
then the vote is repeated. The check is weighted — a triangle's verdict counts for
as much as its weakest edge's inlier support — and high-support edges are shielded,
so the filter quietly disables itself on a uniform-quality graph rather than
inventing drops.

One subtlety drives *when* it runs. Relative rotations are only trustworthy once
the [focal length](help:focal-length) is right, so on a badly-estimated
[intrinsic](help:camera-intrinsics) the filter can reject **true** edges. WebSfM
therefore stashes dropped edges and re-evaluates them after the first
[self-calibration](help:self-calibration) pass has corrected the focal, re-admitting
the ones that were only failing because the geometry was still wrong.

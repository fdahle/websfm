---
id: coarse-to-fine
title: Coarse-to-fine matching
aliases: coarse to fine, coarse-to-fine
summary: Find roughly where two images overlap at low resolution first, then match only there at full detail, so neither pass has to do the other's job.
---
**Coarse-to-fine** matching splits one hard search into two easy ones. A
low-resolution look at both images finds roughly how they line up: offset,
rotation and scale, as one [homography](help:homography). Matching then
repeats at full detail inside small windows that the coarse result predicts.

Each pass removes the other's weakness. Over a large area, full-resolution
matching is slow and finds many look-alike features. A coarse look is fast and
sees the large-scale layout, but cannot place a point to better than one of its
own large pixels. Once the coarse alignment is known, a fine match only has to
be accepted if it lands near where that alignment predicts. That gate throws
out most false matches before any fitting starts.

Find GCPs uses it to align a project orthophoto with a georeferenced reference.
It may first search sub-windows of a large reference to find a small block. The
fine pass then reads both rasters at the same ground resolution, tile by tile,
and fits each tile on its own. Relief and the slight doming of an uncontrolled
model bend the relationship between the two rasters, and one plane over the
whole block cannot follow that bending.

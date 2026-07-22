---
id: cheirality
title: Cheirality
aliases: cheirality check, positive depth, in front of the camera
summary: A geometric check ensuring a triangulated 3D point lies in front of the cameras that observed it, not behind them.
---
**Cheirality** is a validity check applied during triangulation. The word refers
to the "handedness" or sign of a point's depth — whether it sits in front of a
camera or behind it.

The algebra of intersecting two viewing rays can produce a solution that is
mathematically valid but physically impossible: a point that would have to exist
*behind* the lens to satisfy the equations. This matters most when recovering
relative pose from the [Essential Matrix](help:essential-matrix), whose
decomposition yields four candidate camera configurations — only one of which
places the scene in front of both cameras.

<!-- TODO(image): assets/cheirality.svg - the four candidate decompositions of E drawn as four small two-camera diagrams, with the triangulated point in front of both cameras in exactly one and behind one or both in the other three. -->

WebSfM enforces cheirality by requiring every triangulated [Tie Point](help:tie-point)
to have positive depth in all the cameras that observed it. Points that fail the
check are discarded, and the pose hypothesis that satisfies it for the most
points is the one kept.

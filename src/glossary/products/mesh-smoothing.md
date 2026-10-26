---
id: mesh-smoothing
title: Mesh Smoothing
aliases: Taubin smoothing, Laplacian smoothing, smooth mesh
summary: Moves each vertex of a mesh towards the average of its neighbours to remove small bumps. Taubin's variant alternates a shrinking and an inflating step, so the surface keeps its size.
refs: taubin1995
---
A reconstructed [mesh](help:mesh) carries fine noise: small bumps and ripples from
depth noise in the points it was built from. **Laplacian smoothing** removes it by
moving every vertex part of the way towards the average of the vertices it shares an
edge with. Repeated, that irons out the noise, but it also shrinks the surface:
every convex bump moves inwards, a closed object deflates towards its centre, and an
open terrain mesh pulls in at its edges.

**Taubin smoothing** (1995) avoids the shrinkage by alternating two steps in every
iteration: a shrinking step with a positive weight $\lambda$, then an inflating step
with a negative weight $\mu$ slightly larger in magnitude ($\mu < -\lambda$):

$$v \leftarrow v + \lambda\,\Delta v, \qquad v \leftarrow v + \mu\,\Delta v$$

where $\Delta v$ is the average of the neighbours minus $v$. Together the two steps
act as a low-pass filter. Fine noise, which changes from vertex to vertex, is damped,
while broad shape passes almost unchanged.

<!-- TODO(image): assets/mesh-smoothing.svg - a noisy curved profile, the same profile after many plain Laplacian passes (smooth but visibly shrunken), and after the same number of Taubin passes (smooth and the original size). -->

Smoothing cannot add information. More iterations remove coarser noise but also
round off real edges and corners, so use as few as do the job.

In WebSfM, **Tools ▸ Mesh ▸ Smooth** runs Taubin smoothing with $\lambda = 0.5$ and
$\mu = -0.53$, 10 iterations by default. **Keep the boundary fixed** (on by default)
pins every vertex on an open edge, so a terrain mesh keeps its outline. The
triangles and colours are unchanged, and the result is a new mesh. See
[Build a Mesh](guide:mesh).

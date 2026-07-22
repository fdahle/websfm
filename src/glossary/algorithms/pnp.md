---
id: pnp
title: PnP (Resection)
aliases: PnP, perspective-n-point, resection, P3P, space resection
summary: Solving one camera's pose from known 3D points and where they appear in its image — how each new photo is added to a reconstruction.
---
**Perspective-n-Point (PnP)** — *space resection* in photogrammetry — answers:
given a set of 3D points whose positions are already known, and the pixels they
appear at in one image, where was that camera? It is the workhorse of
incremental Structure from Motion: once a few images are reconstructed, every
subsequent image is added by resecting it against the existing
[tie points](help:tie-point).

Three points suffice in principle. **P3P** solves the minimal case in closed
form, returning up to four candidate [poses](help:camera-pose) that a fourth
point disambiguates. Wrapping P3P in [RANSAC](help:ransac) — WebSfM uses MSAC,
which scores inliers by how well they fit rather than counting them — makes it
robust to the wrong 3D–2D pairs that inevitably come out of matching. The
winning pose is then polished by Gauss–Newton against all its inliers.

<!-- TODO(image): assets/pnp-resection.svg - several known 3D tie points, their observed pixels in a new unposed image, and the rays from those pixels converging to determine the single camera centre and orientation; contrast with triangulation (known cameras, unknown point) in an inset. -->

PnP is the exact dual of [triangulation](help:triangulation): triangulation has
known cameras and solves for a point, resection has known points and solves for a
camera. Alternating the two is what "incremental" means.

**Acceptance is deliberately two-gated in WebSfM.** A candidate pose must clear
an inlier-*ratio* test at the loose RANSAC threshold, and then, after the
nonlinear polish, a second ratio test at a much tighter reprojection threshold.
A pose that only survives the loose gate is not rejected — it is *deferred* to a
later pass, on the reasoning that the same image will resect more confidently
once its surroundings are better reconstructed. Registering it early would bake a
sloppy pose into the model and drag [bundle adjustment](help:bundle-adjustment)
along with it.

Which image to try next is itself a decision: candidates are ranked by how many
well-triangulated points they see and how spread out those points are across the
frame, since correspondences clustered in one corner determine a pose far more
weakly than the same number spread across the whole image.

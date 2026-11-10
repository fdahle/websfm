---
id: self-calibration
title: Self-Calibration
aliases: self calibration, auto-calibration, refine intrinsics, intrinsics refinement
summary: Letting bundle adjustment solve for the camera's internal parameters alongside the poses and points, instead of trusting the values it was given.
---
**Self-calibration** means treating the [camera intrinsics](help:camera-intrinsics)
as unknowns to be solved rather than constants to be trusted. The same
[bundle adjustment](help:bundle-adjustment) that refines poses and points also
adjusts [focal length](help:focal-length),
[principal point](help:principal-point) and
[distortion](help:lens-distortion) coefficients, driving them to whatever values
make the observations most consistent.

It is on by default here for a simple reason: the intrinsics WebSfM starts from
are usually estimates. EXIF focal lengths are rounded and sometimes wrong, sensor
sizes are looked up rather than measured, and a scanned film frame has no EXIF at
all. Because intrinsics are shared across a [sensor](help:sensor) group, one
focal length is constrained by every observation in the group, and there is
genuinely enough evidence to recover it.

<!-- TODO(image): assets/self-calibration.svg - a flat surface reconstructed with a too-short focal length (bowl-shaped, the classic dome artefact) beside the same surface after self-calibration recovers the correct focal, with the residual pattern shown as a radial arrow field in the before case. -->

**The danger is overfitting.** Every parameter freed is a parameter the solver can
misuse to absorb noise, and some are badly correlated with each other — the
classic pair being principal point against camera translation, which produce
nearly identical images and so cannot be separated from a small, weakly-varied
block. The reported error drops while the geometry gets worse; the signature is
the "dome" or "bowl" artefact, a flat surface reconstructed as curved.

A second correlation decides the heights of a **nadir block flown at one height**:
focal length against camera distance. Pointed straight down, a longer focal and a
higher camera see the same image, so the photos barely fix the focal, and the distortion
terms can trade with it. Accurate camera positions fix the cameras, so whatever error
is left in the focal moves the ground instead. A lens model that fits the observations
better can therefore give worse heights. Ground control, oblique photos or a second
flying height separate the two.

WebSfM's default is therefore a **staged schedule** rather than all-parameters-at-once:
refine $f, k_1$ during registration, then escalate to $k_2$, then the principal
point and the decentring terms $p_1, p_2$, then $k_3$ — each unlocked only once the
camera and observation counts justify it. A four-term fisheye's $k_4$ comes last, on
the pass after $k_3$ was first refined. The decentring terms are also tested: the
first solve that frees them runs with and without them, and they stay only where they
clearly lower the reprojection error, as they do for a decentred drone lens. When a
sensor already carries a calibrated distortion model, self-calibration is switched off
instead and the calibration is kept.

Bundle adjustment fits the observations **in the pixels the lens recorded**, with the
whole lens as unknowns, as COLMAP and Metashape do. The steps before it work on a
pinhole view of the keypoints, the recorded pixels undistorted by the current lens,
which is re-derived each time a solve refines the lens. The solved lens is recorded
per sensor, and dense reconstruction uses it so its rasters land in the same frame as
the sparse cloud.

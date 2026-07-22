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

WebSfM's default is therefore a **staged schedule** rather than all-parameters-at-once:
refine $f, k_1$ during registration, then escalate to $k_2$, then the principal
point, then $k_3$ — each unlocked only once the camera and observation counts
justify it. When a sensor already carries a calibrated distortion model,
self-calibration of those terms is switched off instead: the distortion was
removed at ingest, and refitting it would correct the same effect twice.

One invariant underlies all of this: **the pipeline downstream of bundle
adjustment is strictly pinhole**. So after each self-calibrating pass the newly
estimated distortion is *folded out of the keypoints* and the model's
coefficients reset to zero, with the total composed correction recorded per
sensor. Dense reconstruction reapplies that recorded correction so its rasters
land in the same frame as the sparse cloud.

---
id: sparse-reconstruction
title: Sparse Reconstruction
summary: Solves camera poses, calibration, and a sparse 3D tie-point model from verified matches.
category: Reconstruction pipeline
order: 40
---
Sparse reconstruction turns verified matches into camera poses and 3D
[tie point](help:tie-point)s. It grows the model incrementally, registers new cameras
with [PnP](help:pnp), triangulates tracks, and repeatedly runs
[bundle adjustment](help:bundle-adjustment).

## Before you run
Inspect the match graph for disconnected groups or isolated images. A reconstruction
cannot bridge parts of the dataset that have no verified matches. Balanced is the best
first run; higher quality spends more iterations polishing a model, but cannot repair
missing overlap.

## While it runs
In the 3D view, the model is drawn as it grows: the registered cameras and the points
triangulated so far, updated every couple of seconds, and the view zooms out as it
expands. The progress bar moves to the corner so the view stays visible. Big models are
thinned for this picture. The finished model replaces it, together with the clouds
shown before the run.

## Min correspondences
<!-- param: minMatchesForRegistration default: 20 -->
The minimum 3D–2D evidence needed to attempt registering another camera with PnP. Lowering it
may admit weak cameras but makes pose estimation less stable. If only a few images fail,
check their matches and sharpness before relaxing this gate.

## Reprojection threshold
<!-- param: reprjThreshold default: 4.0 -->
The [reprojection error](help:reprojection-error) a match may have and still count as an
inlier, both in camera-pose estimation and in track filtering. It is expressed in
**detection pixels** and automatically scaled to native resolution. Lower is stricter;
raise it cautiously for imprecisely localized features or heavily downscaled detection.

## Bundle adjustment iterations
<!-- param: baIterations default: 30 -->
Solver iterations per bundle adjustment pass. More iterations can improve convergence
at a time cost. A large residual that does not
improve with more iterations usually points to bad matches, poorly fitting intrinsics, weak
geometry, or incorrect control—not an iteration shortage.

## Self-calibration
<!-- param: refineIntrinsics default: Auto -->
**Auto** solves focal length and radial distortion for EXIF-only cameras, but preserves
an existing calibrated distortion model. A [fisheye](help:fisheye-lens) sensor with all
coefficients zero counts as uncalibrated: Auto refines its focal length, principal point
and its own fisheye terms in the pixels the lens recorded, k4 of a four-term lens last,
once k1–k3 have been refined. If the fit with k4 would bend the lens curve back on
itself before the image corner, that pass is solved again without k4 and k4 keeps its
value for the rest of the run (the log says so). Turn calibration off only when the sensor
parameters are trustworthy. Solving many parameters needs many well-distributed views;
on a weak network it can absorb scene error into implausible intrinsics. Self-calibration
runs inside bundle adjustment, so it is unavailable when bundle adjustment iterations are
set to 0.

## Check the result
Camera positions should follow the capture path, most useful images should register,
and the cloud should have coherent shape.

Two log lines report checks the run makes on its own. Images with no focal length in
their metadata get one estimated from the verified pairs before registration (**focal
from pair geometry**); without it, the default guess can be far enough off to bend the
whole model. After bundle adjustment the **registration check** compares every camera
with the geometry of its strongest image pairs. A camera that disagrees was registered
in the wrong place: it is taken out, registered again against the finished model, and
left out if it still disagrees, because a missing camera does less harm than a
misplaced one. In the Quality Report, check reprojection
error, track lengths, calibration drift, coverage, and disconnected components before
continuing to depth maps.

Near the end of a run the log reports **track completion**: once the cameras are final,
every verified match that links an existing point to a keypoint in another image adds
that observation if it agrees with the point. This turns many two-view points into
points seen by three or more images. Once the model has a strong multi-view core, the
delivered model drops the remaining two-view points, except where one is the only
coverage of its part of an image, so thin-overlap areas of a block are not left empty.

It then reports **guided track extension**. Each point is projected into the
registered images that do not yet see it, and a keypoint with a matching descriptor is
searched for within a few pixels of the projection. This finds observations that
matching missed, typically on repetitive façades, and usually adds 5–30 % more
multi-view points. A following **audit** line compares the added observations' errors
with the rest of the model. They should be similar; much larger values point to a weak
model, for example film scans without fiducials.

## Sparse gradual selection
Open **Tools → Model ▾ → Gradual selection**. Choose
reprojection RMS error (select above the threshold), track length (select below),
or maximum triangulation angle (select below). The slider previews selected and
remaining counts before **Delete selected + refine**.

Refinement preserves surviving tracks and fixes camera calibration while bundle
adjustment updates camera poses and points. It is held to the same enabled ground
control and camera positions as the original solve, so it cannot undo a GCP
correction; the log states how many GCP anchors and camera positions constrained it. It refuses a disconnected camera
network, fewer than six surviving observations in any camera, or missing stored
photo measurements. Cancel or solver failure preserves the original model. A
successful edit replaces the main sparse model and invalidates depth maps, computed
dense/mesh output, DEM, orthophoto, scale and georeference; rebuild/refit those next.
Save a project copy first if you want to retain the previous solution.

## Optimize cameras
**Tools → Model ▾ → Optimize cameras** re-runs bundle adjustment on the finished
model with the **focal length** free (optionally the **principal point** too),
shared by every image of a sensor, and every point kept. Use it after adding or
correcting ground control, or after gradual selection, when the reprojection error
or the GCP residuals suggest the calibration is slightly off.

It is held to the same ground control and camera positions as the original solve.
It refuses a change of the focal length larger than 20 %, which is a runaway rather
than a refinement, and it refuses a solve that raises the residual (unless survey
constraints explain the increase). Radial distortion stays as the reconstruction
calibrated it: a different radial term would no longer match the observations the
dense stage warps by. Re-run the reconstruction with self-calibration to change it.
[Fisheye](help:fisheye-lens) cameras are solved in the pixels their lens recorded, with
the lens the reconstruction ended with, and their stored observations are re-derived for
the new focal length.
Like gradual selection, a successful run replaces the main model in place and clears
its dense, mesh, DEM, orthophoto, scale and georeference results.

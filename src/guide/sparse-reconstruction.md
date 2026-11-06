---
id: sparse-reconstruction
title: Sparse Reconstruction
summary: Solves camera poses, calibration, and a sparse 3D tie-point model from verified matches.
category: Reconstruction pipeline
order: 40
---
Sparse reconstruction turns verified matches into camera poses and 3D
[tie point](help:tie-point)s. It grows the model one camera at a time with
[PnP](help:pnp), triangulates points and refines everything with
[bundle adjustment](help:bundle-adjustment).

## Before you run
Check the match graph for disconnected groups: no reconstruction can join parts without
verified matches. [Disabled](guide:getting-started) images are left out. Balanced is the
right first run; higher quality polishes a model but can't repair missing overlap.

## While it runs
The 3D view draws the model as it grows, and you can orbit and zoom it. The rest of the
app is lightly dimmed and locked until the run ends, with the progress card in the
view's corner. The finished model then replaces the live one.

## Mode
<!-- param: addToModel  default: Add to the model when the model can take the new images, otherwise Rebuild -->
**Add to the model** places the images the model doesn't hold yet (photos added since,
a block from [Import Project](guide:import-project), images an earlier run couldn't
place) and leaves the rest as it is; match them first with
[Match only new pairs](guide:match-features). Images that can't be placed are named in
the console; Quality Report ▸ Sparse ▸ **Try again…** retries them. **Rebuild** builds a
new model from all images. Imported models, images detected again since, and fisheye
cameras need a rebuild.

## Existing cameras
<!-- param: existingCameras  default: Auto -->
**Fixed** keeps the model's cameras where they are, so the depth maps, clouds and
products built on it stay current (build depth maps for the new images). **Refined**
then lets all cameras move (Optimize cameras), which outdates what was built. **Auto**
picks Fixed when something was built from the model, else Refined.

## Min correspondences
<!-- param: minMatchesForRegistration default: 20 -->
How many 2D–3D matches a camera needs before it is placed. Lowering it admits weaker
cameras with less stable poses; check failing images' matches and sharpness first.

## Reprojection threshold
<!-- param: reprjThreshold default: 4.0 -->
The largest [reprojection error](help:reprojection-error), in detection pixels, an
observation may have and still count. Lower is stricter; raise it cautiously for
imprecise features.

## Bundle adjustment iterations
<!-- param: baIterations default: 30 -->
Solver iterations per bundle adjustment. A large error that more iterations don't
reduce comes from bad matches, poor intrinsics, weak geometry or wrong control, not
from too few iterations.

## Self-calibration
<!-- param: refineIntrinsics default: Auto -->
**Auto** solves focal length and lens distortion (including decentring, where it clearly
helps) for cameras known only from EXIF, and keeps a calibration you entered. Turn it off (**None**) when the calibration is
trustworthy. Many parameters need many well-spread views: on a weak network, such as a
short strip of wide-angle frames, Auto can bend the block towards its ends. If
checkpoint errors grow towards the edges under Auto but not under None, keep None.

## Rolling shutter
<!-- param: rollingShutter default: Off -->
For drones without a mechanical shutter (most DJI Mini, Air and Mavic models): their
sensor reads the rows one after another while the drone moves, which bends the block
with little sign in the residuals and shows as check-point errors. **Estimate the
readout time** solves it per camera group, the motion taken from the photos' capture
times. Leave it off for a mechanical or global shutter, and for photos without a
capture time.

## Multispectral rig
<!-- param: cameraRig default: One pose per capture -->
For a [multispectral camera](help:multispectral-rig) such as a MicaSense RedEdge or
Altum. **One pose per capture** solves the photos of one trigger together: each band
is seen from its lens's fixed offset to the reference band, starting from the offsets
the camera records and refined from the matches. A band that matches nothing, such as
thermal, still gets its pose from its capture. **One pose per photo** solves each band
image on its own; use it only for cameras that are not rigidly mounted together.

## Check the result
Cameras should follow the capture path, most images should register, and the points
should have a coherent shape. The log reports the run's own checks: a focal length
estimated for images without one, cameras moved or dropped because they disagreed with
their strongest pairs, and observations added by track completion and guided matching.
In the [Quality Report](guide:quality-report), check reprojection error, track lengths,
calibration, coverage and disconnected parts before building depth maps.

## Sparse gradual selection
**Tools ▸ Model ▾ ▸ Gradual selection** removes points by reprojection error (above a
threshold), track length or triangulation angle (below), previews the counts, and
**Delete selected + refine** re-adjusts the model, held to the same control. It
replaces the model and retires its depth maps and georeference; other products are
kept, marked [outdated](help:main-product). Save a copy first to keep the old solution.

## Optimize cameras
**Tools ▸ Model ▾ ▸ Optimize cameras** re-runs bundle adjustment with the focal length
(optionally the principal point) free per sensor, held to the same control. Use it after
adding control or gradual selection when residuals suggest a slightly wrong
calibration. It refuses changes over 20 % and solves that make the residual worse.
Lens distortion stays; re-run the reconstruction with self-calibration to change it.
Like gradual selection, it retires the depth maps and georeference
([Optimize Cameras](guide:optimize-cameras)).

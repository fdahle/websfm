---
id: sensor
title: Sensor
aliases: sensors, camera model, sensor group
summary: A camera definition shared by many images — sensor size, focal length and distortion — so one set of intrinsics is solved for the whole group.
---
A **sensor** in WebSfM is not a piece of hardware but a *grouping*: the set of
images that were taken with the same camera in the same configuration, and
therefore share one set of [camera intrinsics](help:camera-intrinsics). Every
image is assigned to exactly one sensor.

The grouping is what makes calibration tractable. A hundred photos from one
camera give a hundred [poses](help:camera-pose) but only *one* focal length,
principal point and distortion model to solve for — a hundred times more
evidence per parameter than treating each image independently. Splitting a group
that should be shared (or merging two that should not be) is one of the more
consequential mistakes available in the project setup, because it changes what
[self-calibration](help:self-calibration) is even allowed to conclude.

A sensor definition carries:

- **Physical sensor size** in millimetres, which converts a
  [focal length](help:focal-length) in mm into pixels.
- **Focal length**, from EXIF or entered by hand.
- A **lens model** — pinhole, radial, radial2, full Brown–Conrady, rational, or one
  of three [fisheye](help:fisheye-lens) models — declaring how the lens projects and
  which coefficients this camera actually uses. Only the active model's terms are
  applied and refined; declaring more terms than the data supports invites
  overfitting. A fisheye must be chosen by hand (or named in an imported
  calibration): its coefficients alone do not say so.
- A **kind**: a normal digital camera, or `film` for a scanned analogue frame,
  which additionally carries [fiducial marks](help:fiducial-marks) and a
  calibration certificate. A film sensor without marks works on the scan's pixels,
  like a digital one, with its focal guessed from a typical aerial camera.

![Two sensor groups: five drone photos pointing at one shared box of intrinsics (focal length, principal point, distortion), and three film scans pointing at another; under each photo its own pose R, t, the only thing that differs within a group.](assets/sensor-grouping.svg)

WebSfM auto-groups images into sensors from EXIF (camera make, model, focal
length, image dimensions), which is right for most digital projects. Scanned film
names no camera, so scans are grouped by roll, the file name without its frame
number; the make and model a film scanner writes are not taken as the camera. It
has to be corrected by hand when that is still misleading — a zoom lens used at
different settings, two physically different cameras that report the same model
string, or one camera spread over several rolls (Images ▸ Group by ▸ Sensors
shows and changes it). Frames extracted from a video carry no EXIF; they get one
sensor per video (named after it), since all frames of a video come from one
camera. A group whose scan formats or fiducial fits point to more than one camera
is marked in the Sensors list, and **Split camera group…** splits it
([Camera groups](guide:camera-groups)).

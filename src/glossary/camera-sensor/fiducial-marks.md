---
id: fiducial-marks
title: Fiducial Marks
aliases: fiducials, fiducial mark, fiducial, interior orientation
summary: Reference marks exposed onto analogue aerial film, used to recover the geometry of a scan and tie scan pixels back to the camera's calibrated frame.
---
**Fiducial marks** are small reference targets — crosses, notches, or corner
wedges — built into an analogue aerial camera's frame so they expose onto every
negative alongside the image. Their positions in the camera's own coordinate
system are measured once at the factory and written into its **calibration
certificate**, in millimetres.

They exist to solve a problem digital imagery does not have. A scanned film frame
has no inherent relationship between scan pixels and the camera that took it: the
scanner's resolution is arbitrary, the film sits on the platen at an arbitrary
offset and slight rotation, and the film base itself may have shrunk unevenly
since 1970. Without correction, none of the reconstruction's assumptions hold —
the [principal point](help:principal-point) is unknown and the effective
[focal length](help:focal-length) in pixels is unknown.

<!-- TODO(image): assets/fiducial-marks.svg - a scanned film frame slightly rotated and offset on the scanner bed, with four corner and four side fiducials marked; arrows to a second panel showing the same frame after the affine fit, axes now aligned and the principal point at the calibrated location, with the mm grid overlaid. -->

Measuring the fiducials in the scan gives the correspondence that fixes this.
Each mark supplies a scan-pixel position paired with its certified mm position,
and fitting an affine transform through them recovers **interior orientation**:
the scan's true scale (pixels per mm, in each axis), its rotation, its offset,
and with them the principal point and the focal length expressed in pixels.

WebSfM keeps detection and calibration deliberately separate, because they are
different kinds of knowledge:

- **Detection** finds anonymous mark positions in each individual scan, by
  template search refined on the native-resolution crop.
- **Calibration** is the [sensor](help:sensor)-level metric identity — which
  slot is which, the certified mm coordinates, the focal length and principal
  point.

Only when both exist do they join, and the transform is applied **once at
ingest**, exactly like [lens distortion](help:lens-distortion): keypoints are
moved into one shared canonical pixel frame per sensor so that everything
afterwards can treat a film scan as an ordinary pinhole camera. Detections
without a calibration never alter the reconstruction — they are measurements
waiting for a certificate.

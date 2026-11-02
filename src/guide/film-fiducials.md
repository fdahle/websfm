---
id: film-fiducials
title: Film Scans & Fiducials
summary: Detect the fiducial marks on scanned aerial film and calibrate them so each scan gets a correct camera frame.
category: Reconstruction pipeline
order: 15
---
A scanned negative has no fixed link between scan pixels and the camera: scan
resolution, film position and shrinkage are unknown. [Fiducial marks](help:fiducial-marks)
recover it in two steps: **detect** finds the marks in each scan, **calibrate** says
which mark each is and where it sits in millimetres. Give the images a sensor of kind
**Film** first; both commands are under **Tools ▸ Images**.

## Film width and scan pitch
The sensor table converts the focal length to pixels with **format (mm)**, the frame
width from the calibration certificate (230 mm for a 9-inch mapping camera), or with a
**px size** (scan pitch) when no format is set. A pitch that implies a non-standard
film width is outlined in amber, with a **Set to 230 mm?** suggestion; accept it only
when the scan is cropped to the frame. Once fiducials are calibrated, each scan's pitch
is measured from its marks instead.

## Detect fiducials
**Detect Fiducials** searches every scan of the sensor. Choose the mark type, the
positions the camera uses (corners, sides or both) and a tolerance (lower is stricter).
Under Advanced, **Polarity** fixes dark or light marks, and **Generate background
masks** masks the scanner background outside the film frame ([masks](guide:masks)).
Two checks catch wrong hits: marks must be symmetric about the frame centre, and (with
four or more scans) sit where the same mark sits in the rest of the flight. Failing
marks go to review.

**Import ▸ Image Fiducials** reads marks measured elsewhere, one row per mark or one
row per image with a column pair per position, and previews where each goes before
importing.

## Detection type
<!-- param: family  default: Generic -->
The shape of the marks. **Generic** tries dots, crosses and rings: start here.
**Right angle** finds corner notches, **45° cut** a diagonal corner notch with a dot.
**Frame** measures the film frame's corners, for scans with missing or unreadable
marks. If many marks need review, try another type.

## Review uncertain marks
Weak, ambiguous or rejected marks are listed under **Needs review** and stored only once
accepted; open the image to check. *Nothing found here* can't be accepted: place that
mark by hand.

## Place or correct a mark by hand
In the image view, right-click the mark's centre ▸ **Mark fiducial…** and choose the
slot. A hand-placed mark replaces the detected one. Fewer than three marks leave a
scan's interior orientation incomplete.

## Calibrate fiducials
**Calibrate Fiducials** types in the certificate's mark coordinates (mm) and maps each
slot to a mark, or estimates a layout from the scans at a given pitch. Enter the focal
length and principal point and choose the transform (affine suits most scans). Each
scan is then fitted to the certificate and works in one camera frame per sensor.

## Import the certificate
**Import ▸ Calibration** reads a certificate table, one row per camera: focal length,
pitch, principal point and an x/y column in mm per mark, named by position. The sensor
becomes **Film** and is calibrated at once. **Import ▸ Camera Fiducials** takes one row
per mark. The dialog shows which sensor each row updates (by label, the only sensor,
the images named, or a new sensor) and lets you change it; only the values in the file
are set.

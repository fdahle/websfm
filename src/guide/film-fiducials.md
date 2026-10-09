---
id: film-fiducials
title: Film Scans & Fiducials
summary: Detect the fiducial marks on scanned aerial film and calibrate them so each scan gets a correct camera frame.
category: Reconstruction pipeline
order: 15
---
A scanned negative has no fixed link between scan pixels and the camera: the
scanner's resolution, the film's position on the platen and any film shrinkage are
all unknown. [Fiducial marks](help:fiducial-marks) recover that link. Two steps,
deliberately separate: **detect** finds where the marks are in each scan;
**calibrate** says which physical mark each one is and where it sits in millimetres.
Reconstruction uses the marks only once both exist.

Assign the images to a sensor of kind **Film** in the sensor table first; both
commands live under **Tools → Images** and appear only for film sensors.

## Film width and scan pitch
The sensor table converts the focal length (mm) to pixels with the **format (mm)**
column: the width of the image frame from the camera calibration certificate (230 mm
for a 9-inch mapping camera). Enter it there. A format outranks a **px size**: while
one is set, the px size cell shows the pitch derived from it (format ÷ scan width in
pixels) and cannot be edited. To work from a scan pitch instead, clear the format and
type the pitch.

With only a px size, the format cell shows the film width that pitch implies (px size
× scan width). If that is not a standard aerial width (a 230 mm frame or a 240 mm
roll, within 5 %), the cell is outlined in amber and reconstruction logs a warning.
When a 230 mm frame is within 15 %, the cell offers **Set to 230 mm?**. One click sets
the format, and the Activity log records the value and the reason. Accept it only when
the scan is cropped to the image frame. A scan that keeps the film margins spans more
than the frame, so its pitch may be correct. Measure the distance between opposite
fiducial marks in the scan before deciding.

Once the fiducials are calibrated, reconstruction measures each scan's pitch from the
marks, and the format or px size is used only if that fit fails.

## Detect fiducials
**Detect Fiducials** searches every scan of the sensor; no calibration is needed.
Choose the mark **family** (Generic, Right angle, 45° cut, or Frame for the film
edge corner), the **positions** the camera uses (corners, sides, or both), and a
**tolerance** (lower is stricter). Under Advanced, **Polarity** fixes whether marks
are darker or lighter than the film, and **Generate background masks** masks the
scanner background outside the detected film frame.

Each scan is searched on a small preview and every hit is then refined on the
full-resolution scan. Large scans are processed one at a time so the browser does
not run out of memory; the log reports how many run in parallel.

Two independent checks guard against a confident hit on the wrong feature — for
example a mark-shaped blob in the data strip:
- **Layout symmetry** (every scan): fiducials sit symmetrically about the frame
  centre, so the midpoints of opposite marks must coincide. Marks that break this
  are sent to review as *Breaks the layout symmetry*.
- **Batch agreement** (four or more scans): a mark must sit where the same mark sits
  in the rest of the flight. Disagreeing marks go to review as *Disagrees with the
  batch*.

## Review uncertain marks
Marks that were weak, ambiguous, or rejected by a check are listed under **Needs
review**; they are not stored until you accept them. Open the image to look before
accepting. A *Nothing found here* entry cannot be accepted — nothing was measured
there. Place that mark by hand instead.

## Place or correct a mark by hand
In the image view, right-click on the mark's centre and choose **Mark fiducial…**,
then the slot (for example *corner-tl*). Before calibration every slot is offered;
after calibration the list shows the certificate's marks. A hand-placed mark
replaces the detected one for that slot. The sidebar's image list shows how many
marks each film image has; fewer than three means its interior orientation is
incomplete.

## Calibrate fiducials
**Calibrate Fiducials** adds the metric side: either type the camera certificate's
mark coordinates (mm) and map each detected slot to a mark, or estimate a layout
from the scans at a scan pitch you enter. Also enter the focal length and principal
point, and choose the transform (conformal, affine, or projective; affine suits most
scans). Reconstruction then fits each scan to the certificate and works in one
shared camera frame per sensor.

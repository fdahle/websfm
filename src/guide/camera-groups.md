---
id: camera-groups
title: Camera Groups
summary: Check that each sensor holds the photos of one camera, and split a group that holds several.
category: Reconstruction pipeline
order: 12
---
Every photo belongs to one [sensor](help:sensor), listed in the sidebar under
**Sensors**. The photos of a group share one focal length, principal point, lens
distortion and, for scanned film, one [fiducial](help:fiducial-marks) layout:
[self-calibration](help:self-calibration) solves them once for the whole group. That is
right when the group is one camera. When it holds photos of two cameras, one of them is
calibrated wrongly, and the model bends to make up for it.

WebSfM groups photos by their EXIF: camera, focal length and image size. Scans name no
camera, so they are grouped by roll (the file name without its frame number, as in
`CA214732V0046.tif`), one group per roll and scan format, and named after the roll; scans
without a frame number in the name are grouped by size. The make and model a film
scanner writes into its scans are not the camera's, so they are left out (Show
information lists them as *Scanned with*). A calibration file you import groups photos
by the values it gives. Two cameras with the same EXIF, or rolls of one camera you want
solved together, need a split or a merge by hand.

A group's values are your starting point: a run never changes them. Each sparse model
keeps the lens it was solved with, so editing a group later does not change a finished
model or what was built from it. To start the next run from what a model solved, open
the Sensor table, choose **Estimated** and **Use for next run** on the group.

## See and change a photo's sensor
In the sidebar, **Images ▸ Group by ▸ Sensors** lists the photos under their sensors.
Drag photos onto another sensor to move them there, or right-click them ▸ **Set sensor**.
**New sensor from selection** gives them a sensor of their own, a copy of the one they
used. Click a sensor's photo count in **Sensors** to select its photos. A sensor left
without photos stays, so you can move them back; **Remove sensor** drops it.

## When WebSfM suggests a split
A group that may hold photos of more than one camera gets a **⑂** in the Sensors list,
and the Sparse Reconstruction dialog says so at the top. Two things point to another
camera:

- **Scan formats.** A scan batch has one exact size, so photos of another size, even a
  few pixels off, come from another camera or batch. When every frame was cropped to its
  own size, sizes up to 1 % apart count as one.
- **The fiducial fit.** A roll (the file name without its frame number) whose photos
  fit the group's fiducial layout three times worse than the others, and worse than
  half a scan pixel, was likely taken with another camera, or its marks are misplaced:
  check a few of its photos before you split.

WebSfM only suggests; it can't know the focal lengths of scans. A calibration with a
focal length per photo ([Import ▸ Calibration](guide:film-fiducials)) makes one group
per lens; check the scan formats afterwards.

## Split a camera group
Right-click the group ▸ **Split camera group…**. The dialog lists the groups the split
makes, with a few photo names each; **Split into N groups** applies it. The first group
keeps the sensor, the others are copies of it. A fiducial layout estimated from the
photos is estimated again for each group; a certificate's layout applies to all of
them. **Merge into** puts a group back.

Run [Sparse Reconstruction](guide:sparse-reconstruction) again afterwards: the cameras
keep their calibration until it does.

## Split by
<!-- param: splitBy  default: Suggested -->
- **Suggested** uses the evidence above: one group per scan format, and a group of its
  own for each roll that misfits the fiducial layout. It is there only when WebSfM
  suggests a split.
- **Scan format** (*Image size* for a digital camera) makes one group per image size,
  as above.
- **Roll** makes one group per roll.

A group of fewer than 10 photos is marked: self-calibration then leaves its principal
point where it is, and it holds its other terms less well. Prefer fewer, larger groups
unless the cameras really differ.

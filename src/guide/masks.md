---
id: masks
title: Masks
summary: Exclude parts of an image (a film border, sky, the operator, a turntable) from feature detection and the dense cloud.
category: Reconstruction pipeline
order: 17
---
An [image mask](help:image-mask) marks, in red, the pixels of an image the pipeline
ignores. [Detect Features](guide:detect-features) finds no keypoints there,
[Depth Maps](guide:depth-maps) give them no depth (in any image's map), and
[Image quality](guide:model-tools) leaves them out of its scores. A mask added later
doesn't change earlier results: rerun detection, or depth maps, to apply it.

Mask what moves or misleads where it covers much of many images: film borders and data
strips, sky, the operator's shadow, a turntable, passing vehicles.

## Auto mask
**Tools ▸ Images ▾ ▸ Auto mask…** masks the photos by rule, in two steps run in this
order: the **Edges** (a fixed strip, or the film frame found on each scan), then the
**Text** on the photos. Turn on one or both: on film scans the frame covers the border
with its data strip, and Text adds what is printed or written inside the photograph.
**Photos** limits the run to one sensor, such as one film roll. **Run** writes the masks
in the progress window; check them with the **Mask** toggle on the photo, or in
**View ▸ Masks**. For film whose frame shifts between scans, **Generate background
masks** in [Detect Fiducials](guide:film-fiducials) is another way.

## Edges
<!-- param: edges  default: Film frame on film scans, else Off -->
**Fixed strip** masks the same band along the edges of every photo: quick, for a
vignetted edge or scans that all sit alike in the scanner. **Film frame** finds where the
photograph begins on each scan (below) and masks around it, so it follows a frame that
shifts from scan to scan. **Off** leaves the edges alone, for a run that masks text only.

## Mask border
<!-- param: border  default: 40 px -->
The width of the fixed strip on each side, in pixels of the photo. Give the bottom more
where a data strip runs along it.

## Link all sides
<!-- param: linked  default: on -->
Sets all four margins at once. Turn it off to give each side its own, such as a wider
bottom band over a data strip.

## Mask the film frame
**Film frame** finds, on each scan, where the photograph begins: past any bright scanner
bed, through the dark film border with its fiducials, dials and data strip, to the first
stretch of picture. Scans of one size are checked against each other, since a camera's
frames sit in the scanner almost alike: a side that lands far from the others (dark
ground or sky at the photograph's edge, a bright mark on the frame) takes theirs. A side
without a dark border is left unmasked, so for photos without a film frame use **Fixed
strip** or nothing.

## Inset
<!-- param: frameInset  default: 0.5 -->
How far inside the frame found the mask reaches, in % of the scan's long side. The
fiducial notches and the rounded corners of the frame reach into the photograph: raise it
when the mask leaves them, lower it to keep more of the picture.

## Mask text
<!-- param: text  default: off -->
Finds and reads the text on each photo (frame numbers, the data strip, a data card,
annotations written on the print) and masks it, so tie points are not matched between
copies of the same print. Text is read with PaddleOCR in the browser (a one-time download
of about 13 MB, with your permission); what it reads is kept, so a second run with other
settings only redraws the masks. A line counts as text when it reads clearly with at
least three letters or digits: buildings and field edges are found too, but read as
nonsense, and stay unmasked.

## Padding
<!-- param: textPad  default: 20 -->
Pixels added around each text box. Raise it when a mask leaves the edges of the
letters, or for bold or blurred print; at 0 the boxes follow the letters closely.

## Recurring text
<!-- param: textRecurring  default: on -->
Masks text that a camera prints at the same place on its photos (the data strip, the
frame counter, the dials of a data card) on every photo of that sensor, including those
where it was not read, such as under glare. Placed through the
[fiducials](help:fiducial-marks) where every photo has them, else by its position on the
photo. It needs text found on at least three photos of a sensor. Turn it off to mask only
what was read on each photo.

## If a mask exists
<!-- param: existing  default: Merge -->
**Merge** adds the edges and the text to a photo's mask; **Replace** keeps only the new
mask. With Replace and Text alone, a photo without text loses its mask.

## Read text
**Tools ▸ Images ▾ ▸ Read text…** lists the text read on each photo, the lines read
clearly in bold, and what a camera's photos print: the calibrated focal length
("CAL F.L. 153.891", "152.86 mm") and the date of the flight. Each photo votes, and the
value most of them show wins, with how many show it. For a film camera, **Use** sets
that focal length on the camera, as Calibrate fiducials does; compare it with the
camera's calibration certificate when you have one. Where a data card is cut off at the
photograph's edge and only the last digits show ("3.46 mm"), the value is completed for
a 6 in (152 mm) lens and marked so: check it before you use it. Auto mask's Text step reads
the photos the same way, so one reading serves both.

## Paint a mask
Open an image and choose **Tools ▸ Images ▾ ▸ Edit mask**. The toolbox has **Brush**
(B), **Eraser** (E), **Rectangle** (R, Alt-drag erases), **Smart Select** (S),
**Invert** (I), **Import** and **Clear**; `[` and `]` change the brush size, and undo
goes back ten steps. The mask is saved when you leave editing. Very large scans can't
be painted yet, but Auto mask, import, Invert and Clear work on them.

## Smart Select
Click an object to cut it out with SAM2, a segmentation model that runs in the browser
(a one-time download of about 155 MB, with your permission). Alt-click carves away
parts; **Add to mask** (Enter) keeps the outline. Check it first: it may stop at a
shadow or spill into a similar background.

## Masks list
**View ▸ Masks** lists every image's mask state, grouped by size. **Import & apply to
all…** or **to group…** gives one file to many images (a landing gear or rig fixed in
every frame); **Import folder…** gives each image its own file.

## Import a folder of masks
**Import folder…** pairs mask files with images by name, as Metashape and COLMAP write
them: the same name in another folder, the full name plus an extension
(`IMG_0001.jpg.png`), or the name plus `_mask` (`IMG_0001_mask.png`). The dialog shows
the matches and the unmatched files before anything is written.

## Folder import over existing masks
<!-- param: importExisting  default: Replace -->
**Replace** stores the file in place of an existing mask; **Merge** adds its masked
pixels, for example a border mask and a sky mask from two folders.

## Mask file format
A file with transparency: transparent pixels are kept, opaque ones masked (as WebSfM
saves masks). A file without: black is masked and white kept, as in Metashape and
COLMAP; a 0/1 raster reads the same way. TIFF masks, 1-bit CCITT G4 included, work too.

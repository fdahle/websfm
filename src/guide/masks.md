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

## Mask border
<!-- param: border  default: 40 px -->
**Tools → Images ▾ → Auto mask…** masks a band of this many pixels along the image
edges: for the frame and fiducial border of film scans, or a vignetted edge. Images
are grouped by size, each with a preview; **Apply to group** or **Apply to all
groups**. For film whose frame shifts between scans, **Generate background masks** in
[Detect Fiducials](guide:film-fiducials) fits better.

## Link all sides
<!-- param: linked  default: on -->
Sets all four margins at once. Turn it off to give each side its own, such as a wider
bottom band over a data strip.

## If a mask exists
<!-- param: existing  default: Merge -->
**Merge** adds the border to an existing mask; **Replace** keeps only the border. With
all margins at 0, Replace removes the masks.

## Paint a mask
Open an image and choose **Tools → Images ▾ → Edit mask**. The toolbox has **Brush**
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
**View → Masks** lists every image's mask state, grouped by size. **Import & apply to
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

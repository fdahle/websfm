---
id: masks
title: Masks
summary: Exclude parts of an image (a film border, sky, the operator, a turntable) from feature detection and the dense cloud.
category: Reconstruction pipeline
order: 17
---
An [image mask](help:image-mask) marks the pixels of one image that the pipeline
should ignore. It is drawn in red over the image; everything not red is used as
normal. Each image has at most one mask, at the image's own pixel size (a very
large scan's is stored smaller, see *Paint a mask*).

Masks are read by three steps, and only when they run:

- **[Detect Features](guide:detect-features)** drops every keypoint that lands on a
  masked pixel. For SIFT this happens before the keypoint cap, so the masked area
  takes none of the image's keypoint budget.
- **[Depth Maps](guide:depth-maps)** give masked pixels no depth, so they never reach
  the [Dense Cloud](guide:dense-cloud). A neighbouring image's mask is honoured too:
  its masked pixels are not used as matches, so a film border or a moving person in
  one photo cannot leak into another photo's depth map.
- **[Image quality](guide:model-tools)** leaves masked pixels out of the sharpness and
  exposure scores.

A mask added or changed later does not touch results already computed. Rerun
detection (and matching and reconstruction after it) for the sparse model to see it,
and rerun depth maps for the dense cloud.

Mask what moves or misleads: the black border and data strip of a film scan, sky,
the operator's shadow or legs, a turntable that rotates with the object, a vehicle
crossing the scene. A small mask on a few images is not worth the effort; a region
that dominates many images is.

## Mask border
<!-- param: border  default: 40 px -->
**Tools → Images ▾ → Auto mask…** masks a band along the edges of every image: the
top, right, bottom and left margins, in pixels of the original image. Use it for the
frame and fiducial border of scanned film, or for a vignetted or obstructed edge.

The dialog lists the images grouped by size, because a margin in pixels only means
the same thing on images of the same width and height. Each group's thumbnail shows
the masked band in red, in proportion. **Apply to group** masks that group,
**Apply to all groups** every group. Images whose size is not known yet sit in an
*Unknown size* group that cannot be masked from here; open them and paint their
masks instead. If an image cannot be masked (for example, its existing mask cannot be
read), the run stops there and says how many images were masked before it.

A margin is capped at half the image's height (top, bottom) or width (left, right).
For film, **Generate background masks** in [Detect Fiducials](guide:film-fiducials)
masks the scanner background from the detected film frame of each scan, which fits
better when the frame shifts from scan to scan.

## Link all sides
<!-- param: linked  default: on -->
While on, typing a margin for one side sets all four to that value. Turn it off to
give each side its own margin, for example a wider bottom band to cover a data strip.

## If a mask exists
<!-- param: existing  default: Merge -->
What Auto mask does with an image that already has a mask:

- **Merge** keeps the existing mask and adds the border to it.
- **Replace** discards the existing mask and stores only the border.

With all four margins at 0 there is no border: **Replace** then removes the images'
masks, and **Merge** leaves them as they are.

## Paint a mask
Open an image and choose **Tools → Images ▾ → Edit mask** (or **Edit** next to an
image in the Masks list). A small Mask toolbox opens over the image:

- **Brush** (B) paints the mask, **Eraser** (E) removes it. **Size** is the brush
  radius on screen, so zoom in for fine edges. `[` and `]` change it.
- **Rectangle** (R) masks the dragged box; hold Alt while dragging to erase it.
- **Smart Select** (S) cuts out the object you click (see below).
- **Invert** (I) swaps masked and kept pixels, which is quicker than painting
  around a small object you want to keep.
- **Import** loads a mask file for this image; **Clear** removes the mask.
- Undo (Ctrl+Z) and redo (Ctrl+Shift+Z) go back up to ten steps. Click the active
  tool again to pan and zoom without painting.

**Opacity** only changes how strongly the red is drawn. The mask is saved when you
leave editing (× or Esc). Outside editing, the image tab's **Mask** button shows or
hides the red overlay, and the pixel readout under the cursor says whether that
pixel is masked.

Painting needs the image at full resolution: while a large TIFF is still loading
the view says so and editing waits.

A very large scan (a TIFF over 30,000 pixels a side or 200 megapixels, see
[Getting started](guide:getting-started)) is only ever shown as a reduced copy, so
painting (Brush, Eraser, Rectangle, Smart Select) is not available on it yet and the
view says so. Its mask is still shown, and **Import**, **Invert**, **Clear** and
undo work, as do **Auto mask**, the Masks list and **Generate background masks**.
Such a mask is stored 8,192 pixels on the long side and scaled up wherever it is
used, so on a KH-9 scan one mask pixel covers about 8 × 8 scan pixels.

## Smart Select
Smart Select uses SAM2, a segmentation model that runs in the browser. The first use
asks before downloading its weights (about 155 MB); the browser keeps them, so later
sessions start at once, also offline. Choosing the tool prepares the image, which
takes a moment.

Click an object: a cyan outline previews the segment. A new click starts a new
segment; **Alt-click** a part that does not belong to carve it away. **Add to mask**
(Enter) adds the preview to the red mask, **Clear** (Del) throws it away. Check the
outline before adding it: the model separates objects by appearance and may stop at
a shadow or spill into a similar-looking background.

## Masks list
**View → Masks** lists every image with its mask state, grouped by image size, and
can mask many images at once:

- **Import & apply to all…** loads one mask file and gives it to every image, scaled
  to each size group.
- **Import & apply to group…** gives one file to the images of that size.
- Per image, **Import…** loads a file, **Edit** opens the image to paint, and
  **Clear** removes the mask. **Clear group** clears the whole group.

A fixed obstruction that sits in the same place in every frame (a landing gear, a
camera rig) is a good case for one shared file.

## Mask file format
An imported file is stretched to the image's size and read one of two ways:

- **A file with transparency** (a PNG with an alpha channel and at least one
  transparent pixel): **transparent dark pixels are kept; opaque or bright pixels
  are masked**. Draw it transparent where the image is used and white or any opaque
  colour where it is masked. The masks websfm itself stores (red on transparent)
  are of this kind and import back unchanged.
- **A file without transparency** (a JPEG, or a plain black-and-white PNG): by
  brightness, **black is masked and white is kept**, with mid-grey as the cut-off.
  This is the convention of Metashape and COLMAP mask files, so their masks import
  as they are.

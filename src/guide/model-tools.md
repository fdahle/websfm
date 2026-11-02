---
id: model-tools
title: Image Quality, Region and Orientation
summary: Find blurry images before matching, limit the dense stages to the area you care about, and set which way is up for a project without coordinates.
category: Reconstruction pipeline
order: 45
---
These tools live in the **Tools** tab under **Images ▾** and **Model ▾**. Region and
Orient model are interactive: the ribbon opens the tool, and you work in a small
floating toolbox over the 3D view. Esc or the toolbox's × leaves it.

## Image quality
**Tools ▸ Images ▾ ▸ Image quality** scores every image's sharpness and exposure.
Motion blur from a moving drone is a common, silent cause of thin or failed
reconstructions, and it is hard to spot in thumbnails.

**Score all images** rates each image's sharpness relative to the set's median (only
the ranking within one set means anything), leaving masked areas out. Images below
**Blurry below**, or with over a quarter of their pixels black or blown out, are
flagged. **Group flagged** groups them for review; **Remove flagged…** removes them.
Check a flagged image before removing it: shallow depth of field can trigger it.

## Blurry below
<!-- param: minRelative  default: 0.5 -->
The [sharpness](help:image-sharpness), as a share of the set's median, under which an
image is flagged. Raise it (0.6–0.7) to catch a few soft frames among sharp ones; lower
it (0.3) when scenes vary a lot, such as water and land, since open water scores low
without blur.

## Region
**Tools ▸ Model ▾ ▸ Region** sets a box that bounds the dense stages:

- **Depth maps** only search the depth range of the sparse points inside the box,
  so the far background is not searched at all.
- **Fusion** never keeps a point outside the box.
- **Mesh** and **DEM** only use the points inside the box.

**Fit to sparse** or **Fit to dense** fits the box (ignoring stray points), or type the
bounds or drag the face handles in the 3D view, then **Apply**. The region shapes the
next run; nothing already computed is cut. **Remove region** goes back to unbounded
runs. A region belongs to its sparse model and is ignored after a new reconstruction
until applied again.

## Orient model
A project without a georeference has no natural "up". WebSfM then guesses it from the
camera viewing directions, which is right for a nadir aerial block and wrong for a
turntable object or a façade. **Tools ▸ Model ▾ ▸ Orient model** sets it yourself:

- **Up**: **Pick 3 ground points**, then click three points on a floor, table or
  ground plane in the 3D view (green markers). Up is that plane's normal, on the side
  the cameras are on. **From cameras** returns to the automatic estimate.
- **Origin**: **Pick origin** and click a point (white marker), or **Model centre**.
- **X heading**: turns X and Y about up, counter-clockwise in degrees.

**Apply** stores it. The 3D view, DEM and orthophoto grids and exports (with *Apply
orientation*) then use this frame; the coordinates themselves are never rewritten. It
combines with [scale bars](guide:georeferencing); a georeference outranks it. Like a
region, it belongs to its sparse model.

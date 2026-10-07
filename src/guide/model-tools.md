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
**Tools → Images ▾ → Image quality** scores every image's sharpness and exposure.
Motion blur from a moving drone is a common, silent cause of thin or failed
reconstructions, and it is hard to spot in thumbnails.

Click **Score all images**. Each image is analysed at a fixed working size, so
cameras of different resolution are comparable, and masked areas (sky, the operator)
are left out. The table shows each image's sharpness **relative to the median** of
this batch: texture varies from scene to scene, so only the ranking within one set
of photos means anything. Images below **Blurry below** (0.5 × median by default) are
flagged, as are images with more than a quarter of their pixels crushed black or
blown white.

- **Group flagged** puts the flagged images in an image group named *Low image
  quality*, so you can review them. Groups only organise the list; they do not
  change the pipeline.
- **Remove flagged…** removes them from the project, after the usual confirmation.

Rescore after changing masks. A frame that is sharp only in one corner (shallow depth
of field) may still be flagged; check it before removing it.

## Region
**Tools → Model ▾ → Region** sets a box that bounds the dense stages:

- **Depth maps** only search the depth range of the sparse points inside the box,
  so the far background is not searched at all.
- **Fusion** never keeps a point outside the box.
- **Mesh** and **DEM** only use the points inside the box.

The toolbox opens with the saved box, or a box fitted around the sparse points. Use
**Fit to sparse** or **Fit to dense** (both ignore the farthest 2 % of points), or type
the bounds, then **Apply**. The box is drawn in orange in the 3D view. Nothing already
computed is cut: the region shapes the *next* run. **Remove region** goes back to
unbounded runs.

A region belongs to the sparse model it was drawn on. After a new reconstruction it is
drawn grey and ignored, and the dense log says so, until you fit and apply it again.
Imported clouds are never cut by it.

## Orient model
A project without a georeference has no natural "up". websfm then guesses it from the
camera viewing directions, which is right for a nadir aerial block and wrong for a
turntable object or a façade. **Tools → Model ▾ → Orient model** sets it yourself:

- **Up**: **Pick 3 ground points**, then click three points on a floor, table or
  ground plane in the 3D view (green markers). Up is that plane's normal, on the side
  the cameras are on. **From cameras** returns to the automatic estimate.
- **Origin**: **Pick origin** and click a point (white marker), or **Model centre**.
- **X heading**: turns X and Y about up, counter-clockwise in degrees.

**Apply** stores it. The 3D view's grid and view presets, DEM and orthophoto grids,
and point-cloud and mesh exports (with *Apply orientation* ticked in the export dialog)
then use this frame. The coordinates themselves are never rewritten: like a scale bar's
factor, the orientation is part of the frame the products are expressed in. It combines
with [scale bars](guide:georeferencing), and a georeference outranks it.

Like a region, an orientation belongs to the sparse model it was set on and is ignored
after a new reconstruction until you apply it again.

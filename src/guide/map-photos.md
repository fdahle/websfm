---
id: map-photos
title: Photos on the Map
summary: Lay the photos themselves on the 2D map, placed by their aligned cameras or by their footprints, to check coverage and fit at a glance.
category: Start here
order: 7
---
**View ▸ Map ▸ Photos** draws the photos on the 2D map, where they lie on the ground.
It shows coverage, gaps and how well neighbouring photos fit, before you build
anything. It is not an [orthophoto](guide:orthophoto): photos overlap without
blending, and all but the selected photo are drawn from small previews.

In **View ▸ Map ▸ Layers**, the Photos row sets its opacity and whether it shows the
selected photo or every photo.

## How a photo is placed
- **A photo in the [sparse model](guide:sparse-reconstruction)** is cast from its
  bundle-adjusted camera. A grid of rays across the photo is traced to the ground,
  taken from the [tie points](help:tie-point), so the photo follows hills and valleys,
  and its lens distortion is corrected. A film scan shows only what lies inside its
  fiducial frame.
- **Any other photo** is stretched into its [footprint](help:image-footprint) from
  [Footprints from Poses](guide:footprints-from-poses): its four corners on the
  ground, with straight edges between them. Use it to check imported poses before
  matching.

On the map in the project CRS, a photo from the sparse model needs a
[georeferenced](guide:georeferencing) model. With **Model Frame** on, the photos are
drawn in the model's own frame.

Where the ground is steep or the tie points are few, a photo can still be off by a
little; an orthophoto, built on a DEM, is the exact product.

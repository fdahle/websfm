---
id: gap-interpolation
title: Gap Interpolation
aliases: gap filling, hole filling, nodata cells, IDW, inverse distance weighting, inverse-distance weighting
summary: Filling raster cells that received no measurement (nodata) from measured cells nearby. Inverse distance weighting blends them; nearest neighbour copies the closest one.
---
A DEM or an orthophoto is a regular grid, and the points and photos it is made from
are not. Some cells receive nothing: no point fell into a DEM cell, or no photo
could colour an orthophoto pixel. Those cells are **nodata**. They are marked as
missing rather than set to zero, so GIS software skips them instead of reading a
height of 0 m (a DEM GeoTIFF records its nodata value; an orthophoto leaves the
pixel transparent).

Small gaps are an artefact of the grid, not missing knowledge: a cell finer than
the point spacing, or a pixel between two that were sampled. Filling those from
their neighbours is safe. The methods:

- **Inverse distance weighting (IDW)** takes a weighted average of the measured
  cells within a radius, the closer ones counting more. It gives smooth fills:
  $$z_0 = \frac{\sum_i z_i / d_i^2}{\sum_i 1 / d_i^2}$$
- **Nearest neighbour** copies the value of the closest measured cell. It keeps hard
  steps such as a roof edge, but looks blocky.
- **None** leaves the gap as nodata, which shows exactly where nothing was measured.

<!-- TODO(image): assets/gap-interpolation.svg - a raster with a few one-cell holes and one large hole; the small holes filled from measured cells inside the radius circle, the large hole left as nodata because no measured cell lies within the radius of its interior. -->

**The radius is the safety limit.** A cell is filled only when a measured cell lies
within the radius, and filled cells never feed further fills, so interpolation cannot
creep across a large gap one step at a time. A large gap, such as a lake, a roof no
camera saw from above, or the area behind a building, stays nodata: filling it would
invent surface that was never measured. A large radius, especially on a sparse
cloud, does exactly that.

A terrain model is the exception. Once [ground classification](help:ground-classification)
removes a building, the ground under it is a gap no radius should bridge, yet a DTM
needs a height there. The DEM's **Fill enclosed gaps** handles that case
separately. It fills only gaps that measured cells surround on all sides, using a
smooth multi-resolution average of those cells (pull–push), and leaves every gap
that reaches the edge of the survey as nodata.

WebSfM fills gaps in two places, each with IDW over a radius of 2 cells by default.
The [DEM](guide:dem) fills empty height cells, and never grows beyond the measured
extent. The [orthophoto](guide:orthophoto) fills uncoloured pixels, but only inside
the surface: where the surface itself has no height, such as a DEM hole, the pixel
stays transparent. Filled colour is cosmetic; it cannot recover imagery that every
camera missed.

---
id: volume-cut-fill
title: Cut / Fill Volume
aliases: cut/fill volume, cut / fill, cut/fill, cut and fill, cut-and-fill, stockpile volume
summary: The volume of material above (cut) and below (fill) a base surface inside a polygon, measured on a DEM. The standard stockpile and earthworks measurement.
---
Draw a polygon on a [DEM](help:digital-elevation-model) and choose a **base**: the
surface the material sits on, or the level an excavation is dug to. Every cell whose
centre lies inside the polygon contributes its height above or below the base times
the cell's area. Material **above** the base is the **cut** (what would have to be
removed to reach the base), material **below** it the **fill** (what would have to be
added), and the **net** volume is cut minus fill.

$$V_{cut} = \sum_{z_i > b_i} (z_i - b_i)\,A, \qquad V_{fill} = \sum_{z_i < b_i} (b_i - z_i)\,A$$

where $z_i$ is the DEM height of cell $i$, $b_i$ the base under it and $A$ the cell
area.

<!-- TODO(image): assets/volume-cut-fill.svg - a cross-section of a stockpile on sloping ground, the best-fit base plane through the polygon vertices drawn as a line, the material above it shaded as cut and a dip below it shaded as fill, with the DEM cells as columns. -->

The base decides the answer more than anything else. A **plane through the polygon
vertices** follows sloping ground under a pile, so the vertices belong on the ground
at the pile's toe, not on the pile. A **horizontal** base (the lowest vertex, or a
known design level) suits a pit or a level pad. Another DEM as the base turns the
measurement into a [DEM of difference](help:dem-of-difference) between two dates.

Two limits come from the DEM itself. A cell with no height (a hole, or outside the
raster) contributes nothing, so a volume over a patchy DEM is too small; the
**coverage** says how much of the polygon was measured. And the volume is only as
good as the surface: a photogrammetric DEM of a pile sees its top, never the ground
under it, which is why the base has to be assumed.

In WebSfM, **Tools ▸ Measure ▸ Volume** draws the polygon on a DEM and offers a
best-fit plane, the lowest vertex, a custom height or an imported reference DEM as
the base. The units are the DEM's horizontal unit squared times its vertical unit,
and a projected CRS's scale factor is divided out. See [Build a DEM](guide:dem).

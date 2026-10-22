---
id: contour-lines
title: Contour Lines
aliases: contour line, contours, contour interval, index contour, index contours, isolines, marching squares
summary: Lines joining points of equal height, traced from the DEM at a fixed vertical interval. The classic way to draw relief on a flat map.
---
A **contour line** joins every point at one elevation. A set of them at a regular
**contour interval** (every metre, every 5 m) draws the shape of the terrain on a
flat map: lines close together mean steep ground, wide spacing gentle ground, and a
closed ring a hilltop or a hollow. Every few lines one is an **index contour**, drawn
heavier and labelled, so heights can be read off at a glance.

From a [DEM](help:digital-elevation-model) the lines are traced with **marching
squares**. Take each square of four neighbouring cell centres. Where a contour level
lies between the heights of two corners, the line crosses that edge, at the point
found by interpolating linearly between them. Joining the crossings square by square
gives the lines. A square whose diagonal corners are above the level and the other
two below (a saddle) could be read two ways; the square's mean height decides, so
lines of one level never cross.

<!-- TODO(image): assets/contour-lines.svg - a small DEM grid with heights at the cell centres, one level traced through the squares by its interpolated edge crossings, and a saddle square with both possible readings and the centre value choosing one. -->

Contours inherit the DEM's quality. A spike or a pit becomes a tight ring, noise
becomes wiggles, and a gap that was interpolated over gets lines through surface
nobody measured.

In WebSfM, **Tools ▸ Products ▸ Contours** traces levels at multiples of the
interval, in the DEM's vertical unit; an interval of 0 picks a round one (1, 2 or 5
times a power of ten) that gives about 25 levels. No line enters a square with a
nodata corner, so lines stop at holes and stay open rather than bridging them.
**Smoothing** passes (a moving average along each line) round off the corners of the
grid crossings; strong smoothing pulls closed rings slightly inwards, and 0 keeps the
exact crossings. Lines shorter than a set length can be dropped. The result goes on
the 2D map as a line layer, and downloads as GeoJSON, each line carrying its elevation
and an index flag, or as DXF for CAD, with index contours on their own layer. The DEM itself is not changed. See
[Build a DEM](guide:dem).

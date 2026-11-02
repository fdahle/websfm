---
id: contours
title: Contour Lines
summary: Trace contour lines of a DEM at a fixed interval, with index contours, onto the map or into GeoJSON or DXF.
category: Tools
order: 140
---
**Tools ▸ Products ▾ ▸ Contours…** traces [contour lines](help:contour-lines) of the
main DEM: lines of equal height at a fixed interval, with every few lines an index
contour. On a georeferenced DEM they go on the map as a layer; they can also be
downloaded for GIS or CAD.

## Interval
<!-- param: interval  default: 0 (auto) -->
The height between two lines, in the DEM's units. **0** chooses a round interval that
gives a readable number of lines over the DEM's height range. Choose a fixed one to
match a map series, such as 1, 2 or 5 m.

## Index contour every
<!-- param: indexEvery  default: 5 -->
Every this many lines is an index contour, put on its own layer and drawn heavier in GIS
and CAD. 5 with a 1 m interval gives an index line every 5 m.

## Smooth the DEM first
<!-- param: generalize  default: 2 -->
Smooths the heights over about this many cells before tracing, so the noise of a
photogrammetric DEM does not trace as small rings and jagged lines. **0** traces the
heights as they are; raise it on a noisy or fine-celled DEM.

## Smoothing
<!-- param: smooth  default: 1 -->
Passes that round off the traced lines' corners. **0** keeps the exact grid crossings,
which look stepped at a fine interval.

## Drop lines shorter than
<!-- param: minCells  default: 20 -->
Removes short closed loops and fragments, in DEM cells: the bumps of rocks, bushes and
noise. **0** keeps every line.

## Download
<!-- param: format  default: No download -->
**GeoJSON** for GIS, **DXF R12** for CAD, with index and other contours on separate
layers. **No download** only puts the lines on the map.

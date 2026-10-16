---
id: classify-ground
title: Classify Ground
summary: Labels every point of a dense cloud as ground, above ground or low noise, so a bare-earth DTM can be built from the ground alone.
category: Products and export
order: 66
---
A [DEM](help:digital-elevation-model) built from every point is a surface model: it
follows roofs and tree tops. **Tools ▸ Point Cloud ▸ Classify ground…** finds the
points that lie on the terrain with a [cloth simulation filter](help:ground-classification).
Then **Build DEM ▸ Points ▸ Ground only** makes a bare-earth terrain model (DTM)
from them.

The result is a new cloud, coloured by class; the source stays as it was. Each point
gets a standard LAS class: **Ground** (2), **Unclassified** (1) for everything above
the ground, **Low point** (7) for noise below it, and **Never classified** (0) for
points outside the classified extent. The classes are saved with the project and
written to LAS, LAZ and PLY exports. The cloud's symbology dialog can hide a class
or recolour it.

The settings are lengths in metres measured along the vertical, so the project needs
real-world scale: a georeference or scale bars. A computed cloud in model units is
refused. An imported cloud is classified in its own coordinates; its z axis must
point up and its units are taken as metres.

## Cloth resolution
<!-- param: clothResolution default: 1 m -->
The spacing of the simulated cloth. The cloth spans anything it cannot fit into, so
a coarser cloth bridges wider roofs, and a finer one follows steeper and smaller
ground forms. At 1 m it bridges roofs up to about 40 m across and follows slopes
up to about 30 %. Use 2 m for large halls or warehouses, and 0.5 m for steep mountain
terrain. A finer cloth costs more time: about 5–10 s per km² at 1 m, four times
that at 0.5 m. Above 4 million cloth points the resolution is coarsened, and the log
says so.

## Terrain
<!-- param: rigidness default: Rolling relief -->
How stiff the cloth is. **Steep slopes** gives a soft cloth that bends into valleys
and onto ridges. **Flat** gives the stiffest cloth, which spans buildings best but
lifts off hilltops. **Rolling relief** (default) suits most drone sites. When ground
on hilltops or along the top of a slope comes out unclassified, choose a softer
cloth or a finer resolution.

## Slope smoothing
<!-- param: slopeSmoothing default: On -->
A stiff cloth settles below steep ground. Slope smoothing walks outwards from where
the cloth touched the cloud and pulls it onto every neighbouring cell whose ground
continues without a step of more than 0.3 m. Walls and roof edges are larger steps,
so it stops there. Turn it off only to see what the cloth alone found.

## Ground tolerance
<!-- param: classThreshold default: 0.5 m -->
How far a point may lie from the cloth and still count as ground. Points higher than
this are Unclassified, points lower are Low points. Raise it for a noisy cloud, such
as one from low-quality depth maps or a rough surface. Lower it to keep low
vegetation, kerbs and cars out of the ground class. It cannot be smaller than the
cloud's own noise, or real ground drops out.

## Extent
<!-- param: extent default: Dense core -->
**Dense core** classifies the same area a DEM covers by default: the dense part of
the cloud, without the thin far background that oblique photos see. Points outside
it are left Never classified (class 0) and never reach a DTM. **All points**
classifies the whole cloud, which makes the cloth larger.

## Correcting the result by hand
Where the filter is wrong, for example a hilltop it lifted off or a low roof it kept
as ground, select those points in the 3D view (**Tools ▸ Point Cloud ▸ Select**) and
use **Assign class** in the selection toolbox. See [Dense cloud](guide:dense-cloud).

## Low points and noise
The filter takes the lowest point in each cloth cell as the ground there. One
isolated point far below its neighbours is treated as noise and ignored. A cluster
of below-ground noise is not, and holds the cloth down around it. Run **Tools ▸ Point
Cloud ▸ Remove outliers…** first when the cloud has such clusters.

---
id: classify-ground
title: Classify Points
summary: Labels every point of a dense cloud as ground, building, low, medium or high vegetation, or low noise, so a bare-earth DTM can be built from the ground alone.
category: Products and export
order: 66
---
A [DEM](help:digital-elevation-model) built from every point is a surface model: it
follows roofs and tree tops. **Tools ▸ Point Cloud ▸ Classify points…** (called
Classify ground before 0.6) finds the points that lie on the terrain with a
[cloth simulation filter](help:ground-classification). Then **Build DEM ▸ Points ▸
Ground only** makes a bare-earth terrain model (DTM) from them. Among the points above
the ground it then finds [buildings and vegetation](help:point-classes) from the
shape of each point's neighbourhood and, where the cloud has colour, how green it is.

The result is a new cloud, coloured by class; the source stays as it was. Each point
gets a standard LAS class: **Ground** (2), **Building** (6), **Low**, **Medium** and
**High vegetation** (3, 4, 5), **Unclassified** (1) for everything else above the
ground (cars, fences, poles), **Low point** (7) for noise below it, and **Never
classified** (0) for points outside the classified extent. With Buildings and
Vegetation off it does what Classify ground did: ground, unclassified and low points. The classes are saved with the project and
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
that at 0.5 m, and gains nothing once it is finer than the points are spaced. Above 4
million cloth points the resolution is coarsened, and the log says so (a streamed
cloud: per tile, below).

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

A *streamed* cloud (a survey too large for memory, see
[Point Cloud Tools](guide:point-cloud-tools)) is classified tile by tile, always over
all of its points. Each tile is read with a margin of 40 cloth cells (at least 30 m)
around it, so a building on a tile edge is still spanned. A tile whose cloth (with its
margin) would need more than 4 million points uses a coarser one, and the log says how
many tiles did; neighbouring tiles at different resolutions can then classify the
ground slightly differently along their edge, so on a sparse survey a cloth resolution
about the point spacing keeps every tile alike (the dialog shows how many cloth points
the cloud needs). The tiles run on every worker at once. The result is a new streamed
cloud.

## Find buildings
<!-- param: buildings default: On -->
Finds roofs and walls: flat surfaces above the ground, large and high enough to be a
building (the next two settings). Each surface grows from the points around it whose
neighbourhood is a plane, and takes the roof edges and corners with it, which see two
planes at once. A flat surface that is green, such as a clipped hedge, is not a
building when the cloud has colour. Off, roofs and walls stay Unclassified.

## Minimum height
<!-- param: minBuildingHeight default: 2.5 m -->
How high above the ground a surface must reach, at its highest point, to be a
building. A garden shed is about 2.5 m; raise it to leave sheds and carports out,
lower it for low farm buildings. A car (about 1.5 m) stays below it.

## Minimum area
<!-- param: minBuildingArea default: 10 m² -->
How large one roof or wall surface must be. It counts the surface itself, so a
pitched roof's two faces count apart. Smaller flat things, such as a car roof (about
4 m²), a sign or a low wall, stay Unclassified. Raise it on a noisy cloud where small
flat patches appear in tree crowns.

## Find vegetation
<!-- param: vegetation default: On -->
Finds trees, shrubs and low plants among the rest: points whose neighbourhood
scatters in every direction instead of forming a surface, and, where the cloud has
colour, points that are green. Scatter right beside a flat surface is the edge of
something built, so it counts only when it is green. A cloud without colour, such as
one from film scans, is classified by shape alone. Each point takes its class from
how high its part of the plant reaches above the ground (the next two settings).

## Low up to
<!-- param: lowVegetationMax default: 1 m -->
Vegetation up to this height above the ground is Low vegetation (class 3): grass,
crops, low plants. The LAS standard leaves the heights to the user; match a
specification you deliver to.

## Medium up to
<!-- param: mediumVegetationMax default: 3 m -->
Vegetation up to this height is Medium (class 4), shrubs and hedges; above it is High
vegetation (class 5), trees.

## Correcting the result by hand
Where the filter is wrong, for example a hilltop it lifted off or a low roof it kept
as ground, select those points in the 3D view (**Tools ▸ Point Cloud ▸ Select**) and
use **Assign class** in the selection toolbox. See [Dense cloud](guide:dense-cloud).

## Low points and noise
The filter takes the lowest point in each cloth cell as the ground there. One
isolated point far below its neighbours is treated as noise and ignored. A cluster
of below-ground noise is not, and holds the cloth down around it. Run **Tools ▸ Point
Cloud ▸ Remove outliers…** first when the cloud has such clusters.

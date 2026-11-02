---
id: copernicus-dem
title: Copernicus DEM
aliases: Copernicus DEM, GLO-30, TanDEM-X
summary: The free global 30 m elevation model made from the TanDEM-X radar mission; a reference DEM anywhere on land.
---
The **Copernicus DEM** (GLO-30) is a global elevation model at 1 arc-second, about 30 m,
made from the German **TanDEM-X** radar satellites' DEM (2011–2015), with water flattened
and gaps filled. Its heights are above the EGM2008 geoid
([vertical datum](help:vertical-datum)). TanDEM-X itself needs a registration with DLR;
the Copernicus DEM is free for anyone.

Co-register DEM can fetch it over your DEM (**Copernicus DEM (30 m)**) and use it as the
reference: WebSfM reads only the tiles' part it needs, declares the datum, and the
accuracy the product states (under 6 m horizontally and 4 m vertically at 90 %, so
σ 2.8 m and 2.4 m).

How far to trust it: it is a surface model, so canopy and buildings are in it. The
radar reaches a few metres into dry snow and firn, and the data is from 2011–2015, so
glaciers, pits and new construction have changed since. Use a
[stable ground](help:dem-coregistration) layer of rock and roads where you can. It is
coarse next to a lidar survey, but places a DEM within a few metres anywhere on land.
Products made with it must name it: "Contains Copernicus DEM GLO-30 data, © DLR e.V.
and © Airbus Defence and Space GmbH, provided under COPERNICUS by the European Union and
ESA".

---
id: geodesic-distance
title: Geodesic Distance
aliases: geodesic distance, geodesic distances, geodesic, geodesics, ellipsoidal distance, ellipsoidal area
summary: The shortest distance between two points over the surface of the Earth's ellipsoid, and the area of a shape on that surface. Ground values that do not depend on a map projection.
refs: vincenty1975, snyder1987
---
A **geodesic** is the shortest path between two points on the surface of the Earth's
ellipsoid (WGS 84, here), and its length is the **geodesic distance**. It is the
distance a surveyor means by "ground distance" at the ellipsoid, before any map
projection stretches or squeezes it.

A distance measured on a map is a grid distance: in a projected
[CRS](help:coordinate-reference-system) it is off from the ground by the projection's
scale factor, and in latitude and longitude it has no linear unit at all. Taking it
on the ellipsoid instead gives the same value whatever the map is drawn in. The same
holds for an area: the **ellipsoidal area** is the area of the shape on the
ellipsoid's surface.

Neither includes relief. They are horizontal values at the ellipsoid, like a
planimetric area: a slope is longer and larger on the ground than its footprint.

In WebSfM, **Tools ▸ Measure ▸ Ruler** and **Area** with **Map** as the Layer measure
this way, so they work over the basemap in any project CRS without a DEM or
orthophoto. Lengths use Vincenty's formulae, areas an equal-area projection of the
ellipsoid centred on the shape. See [Build DEM](guide:dem).

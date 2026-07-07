---
id: digital-elevation-model
title: Digital Elevation Model
aliases: DEM, elevation model, digital elevation models, height map
summary: A raster grid of terrain heights — a top-down map where each cell stores the elevation of the ground at that location.
---
A **Digital Elevation Model (DEM)** is a regular grid laid over the survey area in which every cell stores a single height value. It is the map-form summary of the reconstruction's shape: where the sparse and dense clouds are irregular
scatterings of 3D points, the DEM resamples them into an evenly-spaced raster
that GIS tools and downstream analysis can consume directly.

WebSfM builds the DEM by projecting the dense point cloud onto a local
horizontal plane, binning the points into grid cells, and taking a
representative height per cell. Cells with no points are filled by
inverse-distance-weighted interpolation from their neighbours, and a hillshaded spreview is rendered so relief is easy to read at a glance.

The DEM records terrain height; the [Orthophoto](help:orthophoto) records
appearance over the same footprint. Both are derived from the dense geometry
produced by [Multi-View Stereo](help:multi-view-stereo), and both can be
exported as georeferenced GeoTIFFs when the project is tied to real-world
coordinates.

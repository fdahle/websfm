---
id: classify-ground
title: Classify Points
summary: Labels every point of a dense cloud as ground, building, low, medium or high vegetation, or low noise, so a bare-earth DTM can be built from the ground alone.
category: Products and export
order: 66
---
**Tools ▸ Point Cloud ▸ Classify points…** finds the points on the terrain with a
[cloth simulation filter](help:ground-classification), so **Build DEM ▸ Points ▸ Ground
only** can make a bare-earth terrain model (DTM). Above the ground it finds
[buildings and vegetation](help:point-classes) by the shape of each point's
neighbourhood and, with colour, by greenness.

The result is a new cloud coloured by class, with standard LAS classes: Ground (2),
Building (6), Low, Medium and High vegetation (3–5), Unclassified (1), Low point (7) and
Never classified (0) outside the extent. Each point also gets its **height above the
ground** (`heightAboveGround`), for colouring and export. Classes and heights are saved
and exported to LAS, LAZ and PLY.

The settings are lengths in metres, so the project needs real-world scale (a
georeference or scale bars). An imported cloud must have z up and metre units.

## Cloth resolution
<!-- param: clothResolution default: 1 m -->
The spacing of the simulated cloth. Coarser bridges wider roofs; finer follows steeper,
smaller ground forms. 1 m bridges roofs up to about 40 m and follows slopes up to about
30 %. Use 2 m for large halls, 0.5 m for steep mountains (four times the time).
Finer than the point spacing gains nothing.

## Terrain
<!-- param: rigidness default: Rolling relief -->
How stiff the cloth is. **Steep slopes** bends into valleys and onto ridges; **Flat**
spans buildings best but lifts off hilltops; **Rolling relief** suits most sites. If
hilltops come out unclassified, choose a softer cloth or a finer resolution.

## Slope smoothing
<!-- param: slopeSmoothing default: On -->
Pulls the cloth onto steep ground that continues without a step, stopping at walls and
roof edges. Turn it off only to see the cloth's own result.

## Ground tolerance
<!-- param: classThreshold default: 0.5 m -->
How far a point may lie from the cloth and still be ground. Raise it for a noisy cloud;
lower it to keep low plants, kerbs and cars out of the ground. It can't be smaller than
the cloud's noise.

## Extent
<!-- param: extent default: Dense core -->
**Dense core** classifies the area a DEM would cover, leaving the thin far background
Never classified. **All points** classifies everything. A streamed cloud is classified
tile by tile over all its points, on all workers.

## Find buildings
<!-- param: buildings default: On -->
Finds roofs and walls: flat surfaces above the ground, high and large enough (next two
settings). Green flat surfaces such as clipped hedges are not buildings when the cloud
has colour.

## Minimum height
<!-- param: minBuildingHeight default: 2.5 m -->
How high above the ground a surface must reach to be a building. Raise it to leave
sheds and carports out; cars stay below it.

## Minimum area
<!-- param: minBuildingArea default: 10 m² -->
How large one roof or wall face must be. Car roofs, signs and low walls stay
Unclassified. Raise it if small flat patches show up in tree crowns.

## Find vegetation
<!-- param: vegetation default: On -->
Finds trees, shrubs and low plants: points scattered in every direction and, with
colour, green points. Without colour it goes by shape alone.

## Low up to
<!-- param: lowVegetationMax default: 1 m -->
Vegetation up to this height is Low vegetation (grass, crops). Match the specification
you deliver to.

## Medium up to
<!-- param: mediumVegetationMax default: 3 m -->
Vegetation up to this height is Medium (shrubs, hedges), above it High (trees). For a
canopy height model, take the DEM of difference between a high-vegetation DEM (**Points
▸ Classes…**) and a DTM.

## Correcting the result by hand
Select wrong points in the 3D view (**Tools ▸ Point Cloud ▸ Select**) and use **Assign
class** (see [Dense cloud](guide:dense-cloud)).

## Low points and noise
Single points far below the ground are ignored as noise, but a cluster of them holds the
cloth down. Run **Remove outliers…** first when the cloud has such clusters.

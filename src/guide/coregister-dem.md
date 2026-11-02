---
id: coregister-dem
title: Co-register DEM
summary: Move a DEM, or the georeference, onto a reference DEM by the shift and tilt that make their stable ground agree.
category: Products and export
order: 85
---
**Tools ▸ Products ▸ Co-register DEM…** compares a DEM with an imported reference DEM
on ground that has not changed, finds how far the DEM is off, and removes it
([DEM co-registration](help:dem-coregistration)). It runs the steps
[xDEM](https://xdem.readthedocs.io) chains, each one optional: a horizontal shift
(Nuth & Kääb), a vertical shift, and a tilt.

Use it when the DEM's control and the reference disagree, as when Find GCPs takes
positions from a satellite image and heights from a DEM, or when the control is old.
Quality Report ▸ DEM vs reference DEM shows the offset first, and its **Co-register
DEM…** opens this dialog with the same reference and stable ground.

## Reference DEM
<!-- param: reference  default: The first imported -->
The DEM to move onto (**Import ▸ Reference DEM / Ortho**): a lidar survey or a global
DEM. Its [vertical datum](help:vertical-datum) is converted when both DEMs declare one;
declare it, or the vertical shift absorbs the datum difference. Without one of your own,
**Copernicus DEM (30 m)** fetches the free global [Copernicus DEM](help:copernicus-dem)
over the DEM and chooses it: a few metres accurate, enough to find a larger offset.

## Stable ground
<!-- param: stableArea  default: All cells -->
A polygon layer (GeoJSON) of ground unchanged between the DEM and the reference: rock,
roads, bedrock. Only cells inside it are compared. Without one, real change pulls the
fit: a glacier that thinned would be lifted back up.

## Horizontal shift
<!-- param: horizontal  default: On -->
**Shift east and north** finds the horizontal offset (Nuth & Kääb) from slopes facing
every direction, to a few per cent of a cell. Turn it off on flat ground, which shows no
shift.

## Vertical shift
<!-- param: vertical  default: On -->
**Remove the height offset** subtracts the median height difference left after the
shift, so a few blunders don't move it.

## Tilt
<!-- param: tilt  default: Off -->
**Plane** removes a remaining tilt, as left by control bunched on one side;
**Quadratic surface** also removes a bend (DEM only). Off by default, since a tilt fitted
on stable ground in one corner is extrapolated over the rest: turn it on when the stable
ground is spread over the DEM.

## Apply to
<!-- param: applyTo  default: The DEM -->
- **The DEM** adds a co-registered copy, *(co-registered)*, as xDEM does. The model
  and orthophoto stay, so they no longer line up with the copy. A DEM over 4,096 cells
  a side can only be moved through the georeference.
- **The georeference** moves the model onto the reference, so every DEM, orthophoto and
  export built afterwards lands on it; rebuild the earlier products. Later refits keep
  the move until **Remove** in this dialog takes it out. The control stays as it was,
  so its residuals now show how far it is from the reference.

Terrain-dependent biases (along track, with elevation or curvature) are not corrected
yet.

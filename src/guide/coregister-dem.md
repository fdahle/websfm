---
id: coregister-dem
title: Co-register a DEM
summary: Move a DEM, or the georeference, onto a reference DEM by the shift and tilt that make their stable ground agree.
category: Products and export
order: 85
---
**Tools ▸ Products ▸ Co-register DEM…** compares a DEM with an imported reference DEM
on ground that has not changed, finds how far the DEM is off, and removes it
([DEM co-registration](help:dem-coregistration)). It runs the steps
[xDEM](https://xdem.readthedocs.io) chains, each one optional: a horizontal shift
(Nuth & Kääb), a vertical shift, and a tilt.

Use it when the DEM's control and the reference disagree, as they do when Find GCPs
takes positions from a satellite image and heights from a DEM, or when the control is
old. On the Melville Glacier scans (Find GCPs control, 20 m DEM), the DEM was 1.1 m
east and 7.9 m north of REMA, and its NMAD on stable rock went from 6.9 m to 5.2 m
with both shifts, 5.0 m with a plane and 4.9 m with a quadratic surface. Metashape's
DEM of the same photos, by the same measure, is at 5.0 m. Quality Report ▸ DEM vs
reference DEM shows the offset first, and its **Co-register DEM…** opens this dialog
with the same reference and stable ground.

## Reference DEM
<!-- param: reference  default: The first imported -->
The DEM to move onto, imported with **Import ▸ Reference DEM / Ortho**: a lidar
survey, REMA, Copernicus. Its [vertical datum](help:vertical-datum) is converted to the
DEM's when both declare one. A reference with a constant datum offset (geoid against
ellipsoid) is moved onto too: the vertical shift takes it up, so declare the datum.

## Stable ground
<!-- param: stableArea  default: All cells -->
A polygon layer of ground that has not changed between the DEM and the reference:
rock outcrops beside a glacier, roads, bedrock. Only DEM cells inside it are compared.
Without one, every cell is, and real change pulls the fit: a glacier that thinned
50 m would be lifted back up. Import the outlines as a GeoJSON file. At most 20,000
cells are used, spread over the stable ground, however large the DEM.

## Horizontal shift
<!-- param: horizontal  default: On -->
**Shift east and north** finds the horizontal offset by Nuth & Kääb's method, on cells
sloping 5–45° in every direction: flat ground shows no shift, and cliffs are noise.
It needs slopes facing every way; on a flat area turn it off. The shift is found to a
few per cent of a DEM cell.

## Vertical shift
<!-- param: vertical  default: On -->
**Remove the height offset** subtracts the median height difference left after the
shift. The median, not the mean, so a few blunders on the stable ground do not move it.

## Tilt
<!-- param: tilt  default: Off -->
**Plane** fits a plane to the height differences left and removes it: the tilt of a
block whose control was bunched on one side. **Quadratic surface** also removes a bend,
and applies to the DEM only. Both are fitted by least squares on the cells within
three NMAD, twice, and both have a constant term, so they also take up an offset the
vertical shift left. Off by default: fitted on stable ground in one corner, a tilt is
extrapolated over the rest. Turn it on when the stable ground is spread over the DEM.

## Apply to
<!-- param: applyTo  default: The DEM -->
- **The DEM** adds a co-registered copy beside it, named *(co-registered)*, as xDEM
  does: its origin moves and its heights lose the vertical shift and tilt. The
  orthophoto and the model stay where they were, so a co-registered DEM and the
  orthophoto no longer line up by the shift. A DEM over 4,096 cells a side, kept as
  tiles, can only be co-registered through the georeference.
- **The georeference** moves the model onto the reference instead: the georeference's
  similarity is composed with the shift and the plane, and every DEM, orthophoto and
  export built afterwards lands on the reference. The products built before are
  outdated: rebuild them. Every later refit of the georeference keeps the move (the
  log says so), until **Remove** at the top of this dialog takes it out; a new sparse
  model drops it. Running it again on a DEM built in the moved georeference adds the
  new move to the first. The control points stay as they were, so their residuals in
  the Quality Report now show how far the control is from the reference.

xDEM also corrects terrain-dependent biases (along the flight direction, with
elevation or curvature). WebSfM does not do those yet.

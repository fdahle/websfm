---
id: coordinate-reference-system
title: Coordinate Reference System
aliases: CRS, coordinate reference systems, projection, EPSG, projected CRS, vertical datum
summary: The definition that gives coordinates meaning — which model of the Earth they refer to and how it was flattened onto a plane.
---
A **Coordinate Reference System (CRS)** states what a triple of numbers actually
means. Without it, `(-2416731, 1338452, 87.4)` is not a location. A CRS names the
model of the Earth (the datum), the units, and — for a *projected* CRS — the
mathematical recipe that flattens the curved surface onto a plane.

The distinction that matters in practice:

- **Geographic** (e.g. EPSG:4326, WGS84 lat/lon) — angles on an ellipsoid.
  Degrees are not a length: one degree of longitude is ~111 km at the equator and
  a few hundred metres near the poles. Reconstruction math needs metres, so this
  is a poor working CRS.
- **Projected** (e.g. a UTM zone, or EPSG:3031 Antarctic Polar Stereographic) —
  metres on a plane, with a bounded, known distortion inside its area of use.

Every WebSfM project has one **working CRS**, and everything positional —
[GCPs](help:ground-control-point), imported [camera poses](help:camera-pose),
footprints, and the [georeferenced](help:georeferencing) products — lives in it.
Changing it reprojects all of them together rather than reinterpreting the
numbers in place.

<!-- TODO(image): assets/crs-polar.svg - the same Antarctic coastline drawn in a UTM zone (severely distorted, zones converging) and in EPSG:3031 polar stereographic (clean), with the pole marked in both to show why the default choice fails at high latitude. -->

**Polar work is the reason this is first-class here.** UTM zones converge and
become unusable near the poles, and a default assumption of "WGS84 or UTM"
silently breaks Antarctic projects. WebSfM takes an arbitrary proj4 or EPSG
definition instead of a fixed list.

**Vertical is a separate question from horizontal.** A height is only meaningful
relative to a stated *vertical datum* — an ellipsoid, or a geoid model — and the
two can differ by tens of metres. Imported reference elevation data therefore
carries its vertical datum and its declared vertical accuracy, and WebSfM refuses
to fill a GCP's `z` from a raster that declares no vertical accuracy: an
undocumented height would enter the bundle adjustment anchor claiming
survey-grade authority it does not have.

Imported reference rasters keep **their own** native CRS rather than being warped
at import; sampling reprojects the query into the raster's frame instead. Warping
a multi-hundred-megabyte elevation tile would cost minutes, resample the data
once, and have to be redone on every CRS change.

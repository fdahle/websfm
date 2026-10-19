---
id: vertical-datum
title: Vertical datum
aliases: vertical datum, vertical datums, height datum, geoid, geoid undulation, geoid separation, ellipsoidal height, ellipsoidal heights, orthometric height, orthometric heights, EGM2008, EGM96
summary: What a height is measured from — the WGS 84 ellipsoid or a geoid model. The two differ by up to about 100 m, and by tens of metres over Antarctica.
---
A height means nothing until you know what it is measured from. Two references
are common:

- **Ellipsoidal height** (*h*): above the WGS 84 ellipsoid, the smooth surface GNSS
  works on. RTK and PPK positions, REMA and ArcticDEM are ellipsoidal.
- **Orthometric height** (*H*): above the **geoid**, the surface of equal gravity that
  mean sea level follows. Survey benchmarks and most national maps use it. SRTM uses
  the global geoid model EGM96 and the Copernicus DEM uses EGM2008.

The two differ by the **geoid undulation** *N* at that place: *h = H + N*. *N* runs
from −107 m to +86 m worldwide, and from about −60 m to +20 m over Antarctica.
Mixing the two is a systematic error the size of a building. A whole DEM then
looks uniformly too high or too low, and a fit tilts or rescales to absorb it.

WebSfM converts between ellipsoidal heights, EGM96 and EGM2008 with the NGA
geoid grids it ships at 15′ spacing. Against the full models that is good to
5 mm for EGM96, and for EGM2008 to 1 cm typically and 8 cm (p95) over Antarctica.
Under high mountains it can be off by up to half a metre. A national height system
(NAVD88, DHHN2016 …) or a local datum is recorded but never converted, because
its own geoid model is not built in.

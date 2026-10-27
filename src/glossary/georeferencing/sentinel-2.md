---
id: sentinel-2
title: Sentinel-2
aliases: Sentinel-2, Sentinel-2 L2A, Copernicus Sentinel
summary: The European Copernicus satellites that image all land every few days at 10 m; free and open, and one of Find GCPs' references.
---
**Sentinel-2** is a pair of satellites of the European Union's Copernicus programme
that image every land surface, polar ice included, every few days. Its red, green,
blue and near-infrared bands have 10 m pixels. The **L2A** product is corrected for
the atmosphere and cut into 110 km tiles, each in its UTM zone.

Find GCPs can fetch a Sentinel-2 image of the search area as a reference
orthophoto (**Sentinel-2…** beside the reference). The scenes come from the Earth
Search catalogue of the data on AWS Open Data, which needs no account: WebSfM reads
only the window it needs from the three visible bands, and stretches it from the
window's own reflectances, so snow and ice keep their texture where the ready-made
true-colour image turns white.

How far to trust it: a Sentinel-2 image lies within about 11–12.5 m of its true
position 95 % of the time, a σ of about 5 m, and less where ESA has refined it
against its Global Reference Image. With a fraction of a pixel of matching error,
WebSfM declares σ XY 8 m on the fetched image. That is coarser than a drone survey
needs, and enough to place a historical block that has no other control.

Each scene is one day, not a cloud-free mosaic, so the search shows how much cloud
and snow each has. Products made from it must say "Contains modified Copernicus
Sentinel data" and the year.

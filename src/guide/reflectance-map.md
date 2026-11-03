---
id: reflectance-map
title: Reflectance Map
summary: Maps every band of a multispectral camera onto the DEM, calibrated to reflectance, for NDVI and other vegetation indices.
category: Products and export
order: 82
---
The reflectance map puts every band of a [multispectral camera](help:multispectral-rig)
(MicaSense RedEdge or Altum) onto the DEM, one value per band and cell: the share of
sunlight the ground reflects in that band, from 0 to 1. A thermal band is in °C. Run it
after Align with **One pose per capture** and a DEM.

Each cell takes the capture that sees it nearest the middle of its photo, and every band
reads that capture's photo of it, straight from the camera's raw values, corrected for
vignetting, exposure and gain as the camera's calibration describes. Cells are not
checked for occlusion, so it suits open ground, fields and canopy.

The map is added to **Reference Data**: **Style bands…** shows a single band, a
false-colour composite, or an index such as NDVI or NDRE, which the bands' names fill in.
It is a GeoTIFF with one 32-bit band per lens, NaN where no photo sees the ground.

## Calibration
<!-- param: calibration default: Auto -->
How the camera's radiance becomes [reflectance](help:reflectance-calibration). **Panel**
uses the photos of the calibration panel taken on the ground; **Sun sensor** uses the
downwelling light sensor's reading at each photo; **Panel and sun sensor** takes the
scale from the panel and follows changing light with the sun sensor. **Auto** uses both
when it has both. **None** keeps radiance.

## Cell size
<!-- param: gsd default: 0 -->
The map's pixel on the ground. **0** takes the reference band's own
[ground sample distance](help:ground-sample-distance), measured over the DEM. A coarser
cell makes a smaller file and averages nothing: each cell still reads one pixel.

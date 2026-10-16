---
id: cloud-optimized-geotiff
title: Cloud-Optimized GeoTIFF
aliases: COG, COGs, cloud optimized GeoTIFF, overviews, raster pyramid
summary: A GeoTIFF laid out in tiles with reduced-resolution overviews, so a viewer reads only the part and zoom level it needs instead of the whole file.
---
A plain GeoTIFF stores an image as rows at one resolution. To show a zoomed-out
view of a 30,000-pixel orthophoto, a reader has to decode all of it. A
**Cloud-Optimized GeoTIFF (COG)** is still an ordinary GeoTIFF that any GIS opens,
but it is arranged for partial reads:

- **Tiles.** The image is cut into square blocks (a few hundred pixels a side), each
  compressed on its own, so a view needs only the tiles it covers.
- **Overviews.** The file also holds copies at half, a quarter, an eighth of the
  resolution, down to about one tile: a **raster pyramid**. A zoomed-out view reads a
  small overview instead of the full image.
- **Layout.** The index of where every tile lives comes first in the file, and the
  overviews come before the full-resolution tiles. A reader that fetches the first
  few kilobytes knows where everything is. Over the web, with HTTP range requests,
  that is what makes it "cloud optimized"; on a local disk it is what keeps panning
  smooth.

<!-- TODO(image): assets/cog-pyramid.svg - a stack of overview levels, each half the size of the one below and cut into tiles, with a viewport at two zoom levels highlighting the few tiles it reads from each level. -->

WebSfM stores every computed orthophoto as a COG (tiled, with overviews and DEFLATE
compression), written block by block as it is built. The orthophoto's tab and the
map draw it at the resolution the view needs, and the **COG** export is simply the
stored file. A DEM can be exported as a COG too. Overviews are made by averaging
each 2×2 block and skipping nodata, rather than keeping every second pixel, which on
a noisy DEM would read as noise rather than terrain. An imported reference raster
gets a tiled copy with overviews prepared in the background and saved with the
project. See [Build an Orthophoto](guide:orthophoto).

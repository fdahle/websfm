---
id: footprints-from-poses
title: Footprints from Poses
summary: Outline the ground each image covers from its camera pose, before any matching, for match preselection and a first look at coverage.
category: Reconstruction pipeline
order: 25
---
**Tools → Model ▾ → Footprints from poses** draws each image's
[footprint](help:image-footprint) from its [camera pose](help:camera-pose) and
[intrinsics](help:camera-intrinsics): the four image corners are cast as rays from
the camera and placed where they meet the ground. It needs positions with a height,
so it is for imported poses or EXIF GPS, and it runs before any reconstruction.

The footprints are drawn on the 2D map above every layer, and a new run replaces
them. The map opens on them, so footprints that land in the wrong place are obvious at
once. **View ▸ Map ▸ Footprints** shows and hides them, an image's expanded row in the
sidebar says whether it has one, and a right-click on a footprint (or **Export ▸
Footprints**) downloads them as GeoJSON or removes them.
[Preselect by footprint overlap](guide:match-features) uses them to choose which
image pairs to match.

## Ground
<!-- param: ground  default: Terrain model -->
What the corner rays are cast onto:

- **Terrain model** follows the ground. Each corner is placed where its ray meets a
  [DEM](help:digital-elevation-model), so a footprint over a valley is larger and
  one over a hilltop smaller, as the photos really are. Use it whenever the ground is
  not flat.
- **Fixed elevation** is one horizontal plane at a height you type. Use it over flat
  ground, or with no network and no reference DEM.
- **Height above ground** puts a plane under each camera at its height minus the
  flying height. Use it when camera heights are above take-off rather than absolute,
  as some drones record them.

A camera at or below its ground is skipped. With **Terrain model** that usually
means the camera heights are in another [vertical datum](help:vertical-datum) than
the one chosen, or are above take-off.

## Terrain model
<!-- param: demSource  default: Global terrain -->
**Global terrain** reads the elevation tiles behind the map's *Terrain* basemap
(SRTM and other sources, about 30 m), so it works anywhere with no preparation. A
large area is read more coarsely, at most 64 tiles. It needs a connection, or tiles
the app has already kept; see [Offline use](guide:offline). A footprint with no
terrain under the camera or a corner is skipped, and the log names the tile that
failed.

An imported reference DEM is listed here too. It is usually sharper and in your own
datum, so prefer it when you have one.

## Camera heights
<!-- param: poseDatum  default: Unknown -->
The vertical datum the camera heights are given in. Heights from GNSS (RTK, PPK, a
drone's XMP *absolute altitude*) are usually **Ellipsoidal**; the EXIF GPS altitude
is meant to be above mean sea level, close to **Geoid EGM96**. When this and the
terrain model's datum both convert, the terrain heights are converted to the
cameras' datum; the global terrain is EGM96. **Unknown** uses the terrain heights as
they are. The two can differ by tens of metres, which shrinks or grows every
footprint by the same share of the flying height.

## Ground elevation
<!-- param: groundElev  default: 0 m -->
The height of the plane for **Fixed elevation**, in the project's vertical units and
the cameras' datum.

## Flying height
<!-- param: agl  default: 1000 m -->
For **Height above ground**: how far below each camera the ground plane lies.

## Assume nadir
<!-- param: assumeNadir  default: On -->
Treats an image with no orientation angles as looking straight down, with its top
edge to the north. Right for a vertical aerial block; turn it off for oblique images,
which are then skipped until their angles are known.

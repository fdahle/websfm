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

The footprints are drawn on the 2D map, which opens on them, so misplaced ones show at
once. **View ▸ Map ▸ Footprints** toggles them; right-click one (or **Export ▸
Footprints**) to download them as GeoJSON. **View ▸ Map ▸ Photos** stretches the photos
into their footprints: a quick check of positions and angles, not an orthophoto.
[Preselect by footprint overlap](guide:match-features) uses footprints to choose pairs.

## Ground
<!-- param: ground  default: Terrain model -->
What the corner rays are cast onto:

- **Terrain model** casts them onto a [DEM](help:digital-elevation-model): use it
  whenever the ground isn't flat.
- **Fixed elevation** uses one plane at a height you type: flat ground, or offline
  without a DEM.
- **Height above ground** puts a plane the flying height below each camera, for drones
  that record height above take-off.

A camera at or below its ground is skipped; with Terrain model that usually means a
wrong [vertical datum](help:vertical-datum) or heights above take-off.

## Terrain model
<!-- param: demSource  default: Global terrain -->
**Global terrain** (about 30 m, the map's *Terrain* tiles) works anywhere but needs a
connection or cached tiles ([Offline use](guide:offline)). An imported reference DEM is
usually sharper and in your datum: prefer it when you have one.

## Camera heights
<!-- param: poseDatum  default: Unknown -->
The vertical datum of the camera heights: GNSS heights (RTK, PPK, XMP absolute
altitude) are usually **Ellipsoidal**, EXIF GPS altitude close to **Geoid EGM96**. The
terrain is converted to it; **Unknown** uses it as is. The two can differ by tens of
metres, which scales every footprint.

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

## Manual intrinsics
<!-- param: intrinsics  default: Off, or On when no pose has a calibrated sensor -->
A focal length and image size for poses with no calibrated sensor, such as poses
imported without their photos. Poses whose own sensor gives a focal in pixels and an
image size keep it. A focal in mm needs the pixel size to convert it.

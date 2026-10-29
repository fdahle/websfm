---
id: export-camera-poses
title: Export Camera Poses
summary: Write where each camera stood and which way it looked, as estimated by the reconstruction or as imported, to CSV, text or GeoJSON.
category: Products and export
order: 108
---
**Export ▸ Camera Poses** writes one row (or GeoJSON point) per camera: the image
name, the camera's position X, Y, Z, and its orientation as omega, phi and kappa. The
file has the columns **Import ▸ Camera Poses** reads, so it goes back into WebSfM, or
into another project of the same images, as pose priors.

The angles are in degrees, in the photogrammetric convention the pose import uses: the
rotation from the ground into the photo is $R_x(\omega)\,R_y(\varphi)\,R_z(\kappa)$,
with the photo's x to the right, y up and the camera looking down its −z axis. At
omega = phi = kappa = 0 the camera looks straight down, with the top of the photo to
grid north.

**Format** is CSV, tab-separated text (for tools that want it, and spreadsheets that
read a comma as the decimal point), or GeoJSON: one point per camera, named by its
image, for a GIS.

## Source
<!-- param: source  default: Estimated when the sparse model has cameras, else Imported -->
**Estimated by the reconstruction** writes the [camera poses](help:camera-pose) that
[bundle adjustment](help:bundle-adjustment) ended with, one per registered image. They
are placed the way a point cloud export places its points: in the project CRS when the
model is [georeferenced](help:georeferencing), in metres when it has a
[scale bar](help:scale-bar) fit, levelled when you have oriented it (**Orient model**),
and in the model's own frame and units with none of these, or with the dialog's
**Georeference** (or **Apply scale**, **Apply orientation**) box unticked. Estimated
poses have no accuracies.

**Imported poses** writes the poses as you imported them (or as WebSfM read them from
the photos' GPS), in the project CRS, with the accuracy each one was given.

## Orientation
<!-- param: poseOrientation  default: On -->
Writes the omega, phi and kappa columns. Turn it off for camera positions alone, for
example to compare them with GNSS positions of the same flight. **Accuracies** (imported
poses only) then keeps the position accuracies alone.

## Coordinates
<!-- param: geoJsonCoords  default: Project CRS -->
For a GeoJSON file of poses in a CRS. **Project CRS** keeps X, Y and Z as they are and
names the CRS in the file, as the other GeoJSON exports do. **WGS 84** writes longitude
and latitude, as the GeoJSON standard (RFC 7946) asks for and web maps expect; the
height is then a property `Z`, because it is in the project's
[vertical datum](help:vertical-datum), not above the WGS 84 ellipsoid.

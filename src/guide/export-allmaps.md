---
id: export-allmaps
title: Export to Allmaps
summary: Georeference every aligned photo for Allmaps and other IIIF viewers, so the copies on your IIIF image server open warped onto the map.
category: Products and export
order: 112
---
**Export ▸ Allmaps** writes one Georeference Annotation per aligned photo, all in one
JSON file. It is the open IIIF format [Allmaps](https://allmaps.org) reads: open the
file in Allmaps Viewer (viewer.allmaps.org: paste it in, or give it the file's web
address) and each photo loads from your IIIF image server, warped onto the map. Use it
to publish a georeferenced flight of historical aerial photos from the archive that
holds the scans, without making an orthophoto.

Each photo's control points are the grid that [Photos on the map](guide:map-photos)
draws it with: rays from the bundle-adjusted camera cast onto the
[tie points](help:tie-point), written in WGS 84 longitude and latitude, with a thin
plate spline, which passes through every point. The warp follows the relief and the
lens, and a film scan is cropped to its fiducial frame. It needs a
[georeferenced](guide:georeferencing) sparse model.

The file holds no pixels. Allmaps reads them from the IIIF server, which must serve
each photo whole: the control points are pixel positions in it. The export reads each
photo's `info.json` from the server to check: a copy at another size (a smaller
derivative) gets its control points scaled to it, and a photo served in another shape
(cropped, or turned) is left out, with a line in the log. When the server cannot be
reached, or does not let other sites read it (CORS), the photos are written for the
size they were imported at.

## Image address
<!-- param: iiifTemplate  default: none -->
The IIIF Image API address of each photo, the one its `info.json` sits under, with
`{name}` for the photo's file name or `{stem}` for the name without its extension:
`https://iiif.example.org/iiif/3/{stem}`. The dialog shows the address the first photo
gets. A name is URL-encoded, so a `/` in it becomes `%2F`, as IIIF identifiers need.
The project keeps the address and the API version of its last export for the next one.

## IIIF Image API
<!-- param: iiifVersion  default: 2 -->
The version of the IIIF Image API your server speaks, written into each annotation as
its image service type. The export takes it from each photo's `info.json`; this setting
is for the photos whose `info.json` it cannot read.

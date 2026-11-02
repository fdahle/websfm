---
id: detect-targets
title: Detect Targets
summary: Marks checkerboard GCP targets in the photos where the model expects them, so the marks are placed for you and you check them.
category: Tools
order: 143
---
**Tools ▸ Images ▸ Detect targets…** finds the centre of each black-and-white checker
mat, the usual GCP target of a drone survey, in every photo where the model expects
it, and places the GCP's mark there. Marked as detected, with a score, so you review
them in **Edit GCPs** instead of clicking each one.

It looks where a GCP should be: through the [georeference](help:georeferencing) for a
GCP with coordinates, or from its marks in two other photos. So run it after a first
georeference (from the camera positions is enough) or after marking each GCP in two
photos by hand; then [Georeference](guide:georeferencing) again with the new marks.

## Target size
<!-- param: sizeM  default: 0.6 m -->
The side of the mat in metres. It sets how far from the centre the four squares are
checked, from the distance to each camera. Without a scale (no georeference or scale
bars) a middle size is assumed.

## Search radius
<!-- param: searchPx  default: 30 px -->
How far from where the model puts a GCP the centre may be, in photo pixels. Raise it
when the georeference is still rough (camera positions only, a few metres off); lower
it when other targets or road markings lie close by.

## Minimum score
<!-- param: minScore  default: 0.4 -->
How clear a detection must be: the contrast of the four squares, 0 to 1. Raise it if
detections land on paving joints or shadows; lower it for small or faded mats.

## Replace earlier detections
<!-- param: replaceDetected  default: on -->
A new run replaces marks an earlier run detected. Marks you placed or moved yourself
always stay.

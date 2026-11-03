---
id: detect-targets
title: Detect Targets
summary: Marks GCP targets in the photos, checker mats where the model expects them or AprilTags and ArUco markers anywhere, so the marks are placed for you and you check them.
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

[AprilTags](help:apriltag) and [ArUco markers](help:aruco-marker) need no model: each
tag carries its number, so every photo is searched whole, even before Align. Tag 7 is the GCP with 7 as the only number in its
name ("7", "Tag 7", "GCP-07"); a tag no GCP is named after becomes a new marker.

To review, double-click a GCP in the sidebar: its marks sit side by side, each centred
on its crosshair. **✓** accepts a detected mark (it is then yours), **×** removes it,
and **Accept** in the header takes the rest.

## Target type
<!-- param: kind  default: Checker mat -->
**Checker mat**, the black-and-white squares of most drone surveys, is found where the
model expects each GCP. **AprilTag 36h11** and **ArUco** find printed tags of that
family anywhere in every enabled photo; print them with their white border, at least
about 2 photo pixels per cell (a 10-cell tag of 0.3 m at 1.5 cm GSD is 20 px).

## Dictionary
<!-- param: arucoDict  default: 4X4_50 -->
ArUco: the dictionary the markers were printed from, as OpenCV and most generators name
it (DICT_4X4_50 is 4X4_50). Choose the smallest that holds your numbers: a smaller
dictionary tells its markers apart by more cells, so a misread cell is corrected and a
stray pattern is not taken for a marker. 4×4 cells read from farthest away, 6×6 most
safely.

## Target size
<!-- param: sizeM  default: 0.6 m -->
Checker mats: the side of the mat in metres. It sets how far from the centre the four squares are
checked, from the distance to each camera. Without a scale (no georeference or scale
bars) a middle size is assumed.

## Search radius
<!-- param: searchPx  default: 30 px -->
Checker mats: how far from where the model puts a GCP the centre may be, in photo pixels. Raise it
when the georeference is still rough (camera positions only, a few metres off); lower
it when other targets or road markings lie close by.

## Minimum score
<!-- param: minScore  default: 0.4 -->
Checker mats: how clear a detection must be: the contrast of the four squares, 0 to 1. Raise it if
detections land on paving joints or shadows; lower it for small or faded mats.

## Add markers for other tags
<!-- param: addMarkers  default: on -->
AprilTags and ArUco: a tag no GCP is named after becomes a marker "Tag N", with its marks placed,
ready for coordinates or to be renamed. Off, such tags are left out and listed in the
log. A tag's score is 1 when it read without error, lower for each corrected bit.

## Replace earlier detections
<!-- param: replaceDetected  default: on -->
A new run replaces marks an earlier run detected. Marks you placed, moved or accepted
always stay.

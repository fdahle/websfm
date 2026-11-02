---
id: cloud-distance
title: Distance to Reference
summary: Colour every point of a cloud by its distance to a reference cloud or mesh, for change detection and accuracy checks.
category: Tools
order: 126
---
**Tools ▸ Measure ▾ ▸ Distance to reference…** gives every point of a cloud its
[distance](help:cloud-distance) to the nearest point or surface of a reference cloud or
mesh, as a new attribute, and colours the cloud by it. Use it to compare two epochs, or
your cloud with a laser scan. The clouds must be aligned first: an offset shows up as
change everywhere.

## Ignore beyond
<!-- param: maxDistance  default: 0 (no limit) -->
Points farther than this from the reference get no value: parts the reference does not
cover. Set it a little above the largest change you expect, so they do not stretch the
colour scale. **0** measures every point.

## Signed
<!-- param: signed  default: On -->
Gives a sign to the distance: above or in front of the reference positive, below or
behind it negative, along the reference's normals. A reference cloud without normals gives plain
distances: estimate its normals, or compare with a mesh. Turn it off for plain distances.

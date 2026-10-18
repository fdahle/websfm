---
id: elevation-profile
title: Elevation Profile
aliases: elevation profile, elevation profiles, height profile, terrain profile
summary: Heights read off a DEM along a line, plotted against the distance along it. A side view of the terrain where the line was drawn.
---
An **elevation profile** cuts the terrain along a line and shows it from the side:
distance along the line on one axis, height on the other. It answers questions a map
view hides, such as how steep a slope really is, whether a road clears a crest,
where a channel's bed lies, or how tall a bank is.

The heights come from a [DEM](help:digital-elevation-model), sampled at points spaced
along the line. Spacing them about one DEM cell apart reads every cell the line
crosses; closer spacing adds nothing the DEM does not contain, wider spacing can step
over a narrow ditch or wall. Between cell centres the height is interpolated.

<!-- TODO(image): assets/elevation-profile.svg - a DEM in plan view with a polyline drawn across a valley, and below it the profile: height against distance along the line, with a gap where the line crosses a nodata hole. -->

A profile is only as honest as its gaps. Where the DEM has no height (a hole, water
the cameras could not see, the edge of the raster) a profile should show a gap rather
than a line drawn across it, which would invent terrain. The distance is measured on
the map, horizontally, so on a steep slope the length of the ground itself is longer
than the profile's distance axis.

In WebSfM, **Tools ▸ Measure ▸ Profile** draws a polyline on the DEM in front,
samples it at about one-cell spacing with holes left as gaps, and reports the length,
the height range and the relief; **Export profile CSV** downloads distance and height
per sample. For a vertical slice of a point cloud rather than a DEM, use
**Section…**. See [Build a DEM](guide:dem).

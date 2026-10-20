---
id: panoramic-camera
title: Panoramic camera
aliases: panoramic camera, panoramic cameras, optical-bar camera, optical bar camera, panoramic strip, panoramic strips
summary: A camera that sweeps its lens across the scene and exposes a long strip of curved film, so one frame covers a wide angle at a long focal length; no single pinhole describes it.
---
A **panoramic camera** turns its lens across the scene during the exposure, and the
film lies on a curved platen, a cylinder round the lens's axis. The KH-9 Hexagon and
KH-4 Corona reconnaissance satellites carried such *optical-bar* cameras: the KH-9's
had a 1.5 m focal length and swept about 120°, so one frame is a strip of film more
than two metres long and 15 cm high, sharp from edge to edge.

Along the strip, film position measures the scan angle (arc length = focal length ×
angle), not the distance from a centre. A [frame camera](help:camera-intrinsics)'s
pinhole model therefore fits only a small part of a strip. A few degrees of it,
though, can be resampled exactly into a pinhole image of the camera turned to that
angle, which is how websfm reconstructs panoramic strips: as segments, each a frame
camera of its own (see [Split Panoramic Strips](guide:panoramic)).

The satellite also moves while the lens sweeps, several kilometres in one scan, so
the strip is not exposed from one point. Giving every segment its own pose takes up
most of that. A full panoramic model with the scan rate and the satellite's motion is
not built in.

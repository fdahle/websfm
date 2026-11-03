---
id: rolling-shutter
title: Rolling Shutter
aliases: rolling shutter, readout time, electronic shutter
summary: A sensor that reads its rows one after another instead of all at once. A camera moving during the readout sees each row from a slightly different place.
refs: vautherin2016
---
Most small drones have no mechanical shutter: the CMOS sensor exposes and reads its
rows from top to bottom over the **readout time**, a few tens of milliseconds. At
10 m/s over 30 ms the drone moves 30 cm between the first and the last row, several
pixels at a centimetre [GSD](help:ground-sample-distance).

A model that assumes every row was read at once explains such photos surprisingly
well: the whole block shears and bends a little, and the residuals stay small. The
error shows where something independent measures it, at check points and in the
heights.

WebSfM can model it in [bundle adjustment](help:bundle-adjustment): each camera's
pose is the one at its principal row, each row is seen from where the camera had moved
to by then, the motion taken from the photos taken just before and after it, and the
readout time is solved per camera group. Depth maps, orthophotos and textures then
read each photo moved onto its principal row's pose. A mechanical or global shutter
has none of this, and the model only adds an unknown there.

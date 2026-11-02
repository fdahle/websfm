---
id: transform-cloud
title: Transform Cloud
summary: Move, rotate and scale a dense cloud, or apply a 4×4 matrix from another program, into a new cloud.
category: Tools
order: 122
---
**Tools ▸ Point Cloud ▾ ▸ Transform…** moves, rotates and scales a dense cloud,
in double precision, and adds the result as a new one. Use it to put an imported cloud
into the project's frame by hand, or to apply a transform another program (CloudCompare,
Metashape) has computed. For an alignment found from the data, use
[Align to reference (ICP)](guide:align-icp) or **Align by point pairs**.

## Define by
<!-- param: mode  default: Move / rotate / scale -->
**Move / rotate / scale** takes angles, a factor and a shift; **4×4 matrix** takes the
numbers of a transformation matrix, pasted from another program.

## Rotate
<!-- param: rotate  default: 0, 0, 0° -->
Angles about the fixed X, Y and Z axes, applied X first, then Y, then Z. To level a
cloud, rotate about X and Y; to turn it to north, about Z.

## Scale
<!-- param: scale  default: 1 -->
Multiplies every distance from the pivot. Use it to bring a cloud in other units to
yours, such as 0.3048 from feet to metres.

## About
<!-- param: pivot  default: The cloud's centre -->
The point the rotation and scale turn about: **The cloud's centre** keeps it in place,
**The coordinate origin** turns it about 0, 0, 0, as most programs' rotations expect.

## Move
<!-- param: move  default: 0, 0, 0 -->
Shifts the cloud by this much in X, Y and Z, in its own units, after the rotation and
scale.

## Matrix
<!-- param: matrix  default: none -->
16 numbers of a 4×4 matrix (or 12 of a 3×4), row by row, separated by spaces, commas or
new lines. Every point is multiplied by it as given, so it maps the cloud's points to
their new place, as CloudCompare's *Apply transformation* does.

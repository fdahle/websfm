---
id: focal-height-correlation
title: Focal–Height Correlation
aliases: focal–height correlation, focal-height correlation, focal length and flying height, focal weakly fixed
summary: Why a flat block of nadir photos flown at one height cannot tell a slightly wrong focal length from a slightly wrong ground height, even with RTK camera positions.
refs: benassi2017
---
Pointed straight down, a camera with a focal length 0.1 % longer, flown 0.1 % higher
above the ground, takes the same photo. When every camera of a block flies at about
one height, the whole block can make that trade: the ground moves up or down by the
same share of the flying height, and no [reprojection error](help:reprojection-error)
changes. This is the classic correlation of the principal distance with the camera
heights in aerial triangulation.

RTK or PPK camera positions fix the cameras, so a focal error left by
[self-calibration](help:self-calibration) lands on the ground's height instead. At
170 m above the ground, 0.01 % of focal is 1.7 cm of height, and a self-calibrated
focal a few hundredths of a percent off is common. The positions only see it through
the cameras' height differences: a block whose camera heights spread by a twentieth of
the flying height or less learns little about the focal from them.

What separates focal and height:

- [ground control points](help:ground-control-point) used as control, which fix the
  ground itself (keep a few as checkpoints to measure the result);
- a second flight at another height, or cross strips flown higher or lower;
- some oblique photos, whose depth changes across the frame;
- a calibration from a block flown with control, held instead of solved (Import ▸
  Calibration, or a sensor's estimated values used for the next run).

WebSfM checks for it after Sparse Model: when survey-grade positions alone held a
nadir block whose focal was self-calibrated, and their heights spread by less than 5 %
of the flying height, the log warns and Quality Report ▸ Calibration shows what the
focal is worth in height.

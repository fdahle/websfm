---
id: reference-dem-hold
title: Reference DEM Hold
aliases: hold to a reference DEM, DEM-constrained bundle adjustment, DEM constraint
summary: Holding the tie points of a bundle adjustment to a reference DEM's heights, so a weakly controlled block cannot bend.
---
A block without good ground control has a weakness: over a nadir block the focal
length and radial [distortion](help:lens-distortion) trade off against the block's
curvature, so [self-calibration](help:self-calibration) can settle on a model that
domes or dishes by metres at the edges with small residuals everywhere. Drone GPS
cannot stop it: the bent block still fits the camera positions within their few
metres of noise.

A **reference DEM hold** adds a weak vertical observation to each tie point over
stable ground in [bundle adjustment](help:bundle-adjustment): "the ground here is at
the reference's height, give or take σ". One point says little, since a global DEM is
metres off locally, but thousands of them average that noise away and leave a strong
pull against a large, smooth bend, which is exactly the error a domed block has. The
local detail stays the photos': a point's image observations outweigh a hint of a
few metres.

The pull is along the vertical only, as a coarse DEM says nothing reliable about
horizontal position. Points far from the DEM's height (a new building, moved ice, a
blunder) are left out, and the hold is rebuilt over two rounds, as a point that moves
sideways meets the DEM elsewhere. The GCPs or camera positions still place the model;
the DEM only keeps its shape.

It is not [DEM co-registration](help:dem-coregistration), which moves a finished DEM
as a whole and cannot take a bend out. Nor does it fix a wrong camera model: the
focal length and distortion must be free to move, as they are in a self-calibrating
run.

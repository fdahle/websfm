---
id: point-classes
title: Building and Vegetation Classes
aliases: building class, vegetation class, low vegetation, medium vegetation, high vegetation, covariance features, excess green
summary: How Classify Points tells buildings from trees and shrubs above the ground, from the shape of each point's neighbourhood and its colour.
refs: weinmann2015, woebbecke1995
---
After [ground classification](help:ground-classification), every point above the ground
is still just "above ground". Classify Points sorts them further into the ASPRS LAS
classes **Building** (6) and **Low**, **Medium** and **High vegetation** (3, 4, 5);
whatever is neither (a car, a fence, a pole) stays **Unclassified** (1).

It looks at the shape of each point's neighbourhood, a sphere of about a metre. The
spread of the points there, taken as a covariance matrix, has three axes (Weinmann et
al., 2015):

- On a **surface**, a roof or a wall, the points spread along two axes and hardly along
  the third. The neighbourhood is *planar*, and its thin axis is the surface normal.
- In a **tree crown** or a shrub, the points spread along all three: the neighbourhood
  *scatters*.

Planar points join into surfaces where their normals agree. A surface high and large
enough above the ground is a building, together with its edges and corners, which see
two planes at once and so do not look planar themselves. Scattering points are
vegetation, unless they sit right next to a surface (the edges of a car, of a wall too
small to be a building). Where the cloud has colour, green points are vegetation too,
found with the **excess green** index 2g − r − b on the chromatic coordinates
(Woebbecke et al., 1995), and a green surface is never a building. A point's
vegetation class comes from how high its part of the plant reaches above the ground.

To stay fast on dense photogrammetric clouds, the neighbourhoods are taken over voxels
of a quarter metre rather than over every point; each point takes its voxel's class.
These are rules, not a trained classifier: they separate roofs from crowns well, but a
very smooth crown can read as a surface, and a flat patch inside a crown as a roof.
The [guide](guide:classify-ground) says how to tune them, and wrong points can be
reassigned by hand.

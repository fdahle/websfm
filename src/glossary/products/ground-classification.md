---
id: ground-classification
title: Ground Classification
aliases: ground classification, ground filter, cloth simulation filter, CSF, digital terrain model, DTM, bare-earth
summary: Separating the points on the terrain from those on buildings, vegetation and objects, so a terrain model (DTM) can be built from the ground alone. WebSfM uses a cloth simulation filter.
---
A point cloud of a landscape mixes the terrain with everything standing on it. A
[DEM](help:digital-elevation-model) of all points is a **digital surface model
(DSM)**: it runs over roofs and tree tops. A **digital terrain model (DTM)** is the
bare earth beneath them. It needs to know which points are ground, and the photos
alone cannot say. Ground classification decides it from the cloud's shape.

WebSfM uses the **cloth simulation filter** (CSF; Zhang et al., 2016). Picture the
cloud from below, and a cloth pushed up against it from underneath:

1. A grid of cloth particles starts below the lowest point. Each cell's ground
   candidate is the lowest point in it.
2. Every step pushes each free particle up, and springs to its neighbours pull it
   back towards them. A particle that reaches its cell's lowest point sticks there.
3. Where the terrain is open, the cloth sticks to it. Under a roof the cloth comes up
   against the wall foot on all sides and spans the gap, because the springs stop it
   rising far above the particles that stuck. A tree is spanned the same way, or
   reached where the cameras saw the ground between the branches.
4. **Slope smoothing** spreads sticking particles onto neighbouring cells where the
   ground continues without a step. That pulls a stiff cloth onto steep slopes.
5. Each point is ground when it lies within a tolerance of the cloth. Points higher
   than that are above ground, and points lower are noise.

<!-- TODO(image): assets/ground-classification.svg - a side view: terrain with a house and a tree, the cloud from below, a cloth pushed up from underneath that touches the open ground, spans under the roof and between the tree's ground hits; points near the cloth coloured as ground, the rest as above ground. -->

The cloth's resolution and stiffness set what it can span and what it can follow. A
cloth that bridges a 40 m roof also lifts off a sharp ridge narrower than that.
The [guide](guide:classify-ground) gives starting values.

The classes are the ASPRS LAS codes that GIS software reads: 2 ground,
1 unclassified, 7 low point (noise), and 0 for points never classified. A DTM made
from the ground class has holes where buildings stood. [Gap
interpolation](help:gap-interpolation) bridges them.

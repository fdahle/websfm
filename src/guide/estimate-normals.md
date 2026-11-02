---
id: estimate-normals
title: Estimate Normals
summary: Compute a surface normal for every point of a cloud from its neighbours, so an imported cloud can be meshed and shaded.
category: Tools
order: 125
---
**Tools ▸ Point Cloud ▾ ▸ Estimate normals…** fits a plane through each point's nearest
neighbours and stores its [normal](help:surface-normal). Clouds from Dense Model already
have normals; an imported cloud often has none, and [Build Mesh](guide:mesh) and
point-to-plane [ICP](guide:align-icp) need them. A new cloud with the normals is added.

## Neighbours
<!-- param: k  default: 16 -->
How many nearest points each plane is fitted to. More gives smoother normals on noisy
clouds and is slower; fewer keeps sharp edges and corners.

## Point normals face
<!-- param: orient  default: Automatic -->
Which side of the surface the normals point to. **Towards the cameras** uses the
model's camera positions and suits clouds of this project, walls and overhangs included;
**Upwards (+Z)** suits terrain; **Keep existing side** keeps the side of normals the
cloud already has. **Automatic** points a computed cloud towards the cameras and an
imported one upwards. A mesh built from wrongly facing normals comes out inside out.

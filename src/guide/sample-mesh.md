---
id: sample-mesh
title: Sample Mesh to Points
summary: Turn a mesh into an evenly spaced point cloud, with the mesh's colours and normals.
category: Tools
order: 133
---
**Tools ▸ Mesh ▾ ▸ Sample to points…** places points evenly over a mesh's surface and
adds them as a cloud, with colour and normals. Use it to compare a mesh with a cloud
([Distance to reference](guide:cloud-distance)), to align one by
[ICP](guide:align-icp), or to export a mesh to software that reads only clouds.

## Number of points
<!-- param: count  default: 1000000 -->
How many points are placed over the whole surface; their spacing follows from the
surface area. Use about as many as the cloud you compare with, or more for a dense
uniform cloud.

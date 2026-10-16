---
id: statistical-outlier-removal
title: Statistical Outlier Removal
aliases: SOR, statistical outliers, statistical outlier filter, remove outliers
summary: Drops points whose mean distance to their nearest neighbours is unusually large for this cloud. These are the floating specks fusion leaves around a surface.
---
A dense [point cloud](help:point-cloud) nearly always carries a thin haze of
**flyers**: single points floating in front of or behind the surface, left by depth
estimates that slipped through every earlier filter. A real surface point sits in a
crowd of neighbours and a flyer does not. **Statistical outlier removal** turns that
difference into a test:

1. For every point, compute the mean distance $\bar d_i$ to its $k$ nearest
   neighbours.
2. Over the whole cloud, compute the mean $\mu$ and standard deviation $\sigma$ of
   those values.
3. Drop every point that is unusually lonely:

$$\bar d_i > \mu + \alpha\,\sigma$$

The ratio $\alpha$ sets how aggressive it is: lower removes more. Because the
threshold comes from the cloud's own statistics, it adapts to the point spacing and
no distance has to be typed in.

<!-- TODO(image): assets/statistical-outlier-removal.svg - a profile of a dense surface with a few floating points above it, each point's k-neighbour circle drawn, and a histogram of mean neighbour distances with the mean plus ratio times sigma cut-off marked and the flyers falling to its right. -->

It has two blind spots. It assumes roughly even density, so where density varies a
lot, genuine but sparsely sampled surface (the far edge of a scan) can go first. And
a dense *cluster* of wrong points, such as a ghost surface, passes, because each of
its points has close neighbours. Isolated-cluster removal targets the second case;
systematic errors are better fixed upstream, in the depth maps, masks or photos.

In WebSfM it is **Tools ▸ Point Cloud ▸ Remove outliers**, or the **Statistical
outliers** step of **Filter** (12 neighbours, ratio 1.5 by default). A point with no
neighbour at all is dropped outright. In a Filter chain it runs last, after the
range, voxel and isolated-cluster steps, so the neighbour search runs on the
smallest cloud. The result is a new cloud; the source is left untouched. See
[Point Cloud Tools](guide:point-cloud-tools).

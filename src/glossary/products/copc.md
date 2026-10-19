---
id: copc
title: COPC (Cloud Optimized Point Cloud)
aliases: COPC, Cloud Optimized Point Cloud, .copc.laz
summary: A LAZ file whose points are stored as a level-of-detail octree, so a viewer reads only the parts and the detail it needs instead of the whole file.
---
A plain LAS or LAZ file stores its points in whatever order the scanner or the
software wrote them. To show an overview of a 200-million-point survey, a reader has
to decode all of it. A **COPC** file (`.copc.laz`) is still an ordinary LAZ 1.4 file
that any LAS reader opens, but its points are arranged for partial reads:

- **An octree.** The points are sorted into the nodes of a
  [level-of-detail](help:level-of-detail) octree: the top node holds a thin, even
  sample of the whole cloud, and each level below doubles the detail. Every point is in
  exactly one node.
- **One chunk per node.** Every node is compressed on its own, so a view decodes only
  the nodes it shows.
- **A hierarchy.** An index records where every node is in the file and how many
  points it holds. A large file splits it into pages, read as the view goes deeper.

Over the web, with HTTP range requests, that is what makes it "cloud optimized"; on a
local disk it means a huge survey opens without being read.

WebSfM reads an imported COPC file **in place**: the file is copied into the project
as it is, and the 3D view, cropping, DEMs, edits and exports read its nodes from there.
No octree of its own is built, so a COPC file imports in the time it takes to copy it,
where a plain LAZ of the same size is decoded and sorted point by point. Its CRS (the
WKT or GeoKey record) is kept with the cloud and written back on export. COPC is only
read: clouds WebSfM makes are kept in its own octree, which needs no decompression on
every read.

See also: [Cloud-Optimized GeoTIFF](help:cloud-optimized-geotiff), the same idea for
rasters, and [Point Cloud Tools ▸ COPC files](guide:point-cloud-tools).

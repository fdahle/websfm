---
id: merge-clouds
title: Merge Clouds
summary: Join several dense clouds into one, optionally keeping only the first cloud's points where they overlap.
category: Tools
order: 123
---
**Tools ▸ Point Cloud ▾ ▸ Merge…** joins two or more dense clouds into a new one. The
clouds must already share a frame: nothing is moved, so align them first if they come
from different projects or sensors ([Align to reference (ICP)](guide:align-icp)). The
merged cloud has normals only when every cloud has them.

## Dedupe cell
<!-- param: cell  default: 0 (off) -->
Where the clouds overlap, only the first cloud's points are kept within cells of this
size, so the overlap is not twice as dense. **0** keeps every point. Use about the point
spacing of the clouds, and put the cloud you trust most first.

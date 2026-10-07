---
id: depth-maps
title: Depth Maps
summary: Estimates a depth and surface normal for image pixels using neighbouring registered views.
category: Dense reconstruction
order: 50
---
Depth maps are Stage A of dense reconstruction. PatchMatch compares each registered
image with selected source views to estimate per-pixel depth. They are cached because
they are expensive and are also reused as visibility evidence by orthophoto generation.

## Quality
**Medium** runs at one-quarter native resolution and is the normal starting point.
Low is useful for a preview; High and Ultra preserve finer detail but increase runtime
and memory sharply. Resolution cannot create texture that is absent from the photos.

## Source views
<!-- param: maxSources default: 6 -->
How many neighbouring cameras may support each reference image. More sources improve
the chance of finding useful baselines but cost more. Very oblique, distant, or
non-overlapping sources add little.

## Patch window and iterations
<!-- param: window default: 3 -->
A larger comparison window is steadier on weak texture but smooths small detail. More
PatchMatch iterations improve propagation at linear time cost; the default three is a
good first pass.

## Geometric consistency
Keep this enabled for normal work. It projects a depth estimate into other maps and
back, removing pixels that do not agree across views. This is particularly important
for sky, foliage, water, haze, and silhouettes, where a photometric score alone can
look deceptively good.

## Photometric and speckle filters
The NCC floor rejects pixels without sufficient appearance agreement. Speckle cleanup
removes small inconsistent regions. Tight filters produce cleaner but less complete
maps; inspect whether losses affect genuine surfaces before loosening them.

## Compute and memory
WebGPU acceleration is experimental and configured under Settings → Compute. The
worker estimates memory before running and may reduce concurrency. If the browser
runs out of memory, lower quality first; this has the clearest effect on both memory
and time.

## Limit the area
If a **Region** is set (**Tools → Model ▾ → Region**, see
[Image Quality, Region and Orientation](guide:model-tools)), each image's depth search
only covers the sparse points inside it. Images that see little of the region are
skipped quickly, and the far background is never searched. Fusion then drops anything
outside the box. A region drawn on an older model is ignored, and the log says so.

---
id: depth-maps
title: Build Depth Maps
summary: Estimates a depth and surface normal for image pixels using neighbouring registered views.
category: Dense reconstruction
order: 50
---
Depth maps are the first stage of dense reconstruction: [PatchMatch](help:patchmatch)
estimates a depth for each pixel of each registered image from its neighbouring views.
They are saved, because they are expensive and the orthophoto reuses them. A
[disabled](guide:getting-started) image gets no depth map.

The depth map shown over an image runs from red (near) to blue (far). Scattered dots in
another colour, common in trees, water and plain ground, are usually removed by the
cross-view check before fusion.

## Quality
<!-- param: quality  default: Medium -->
**Medium** works at a quarter of the native resolution and is the normal start. **Low**
is a preview; **High** and **Ultra** keep finer detail at a steep cost in time and
memory. If the quality doesn't fit the memory budget, the run steps down to one that
does.

## Working resolution override
<!-- param: maxDim  default: auto -->
Fixes the long side, in pixels, that PatchMatch works at instead of Quality. Leave it
blank normally. It is never stepped down: if it doesn't fit the memory budget, the run
stops before starting.

## Source views per image
<!-- param: maxSources  default: 10 -->
How many neighbouring cameras support each image. More views fill more of the surface
on close-range scenes with many viewpoints, at more cost; very oblique or distant
views add little.

## Sources aggregated (best-K)
<!-- param: bestK  default: auto -->
Each depth is scored on its K best-matching views. A small K tolerates occlusion; a
larger K is less noisy where all views see the surface. Blank picks about half the
views, 1–4.

## Keep valid depth maps
<!-- param: keepMaps  default: on -->
Keeps saved maps whose camera hasn't moved and whose settings are unchanged, and
computes only the others: after [Add to the model](guide:sparse-reconstruction) with
fixed cameras, only the new images. Kept maps don't get the new images as neighbours;
turn it off for that. After a full rebuild, nothing can be kept.

## Method
<!-- param: method  default: Auto -->
**Full** adds better view selection, planar priors for plain surfaces between textured
edges, and a pass that favours depths agreeing with neighbouring maps: a more accurate,
more complete cloud for 2–3× the time on a GPU, more on the CPU. **Fast** is one pass.
**Auto** uses Full on the GPU and Fast on the CPU.

## Patch window radius
<!-- param: window  default: 3 -->
Half-size of the patch compared between images
([photometric consistency](help:photometric-consistency)); 3 compares 7×7 pixels.
Larger is steadier on weak texture but smooths detail and costs more; smaller keeps
edges but is noisier.

## Iterations (per level)
<!-- param: iterations  default: 5 -->
How many [PatchMatch](help:patchmatch) sweeps run at the finest level. More fill more of
weakly textured areas, at linear cost; lower it for a quick look.

## Speckle / median filter
<!-- param: speckleFilter  default: on -->
Removes flying pixels and single-pixel noise from each map against its local median.
Keep it on; turn it off only to inspect raw output.

## Speckle tolerance
<!-- param: filterRelTol  default: 10% -->
How far from the local median a depth may be before the speckle filter drops it. Raise
it if roof edges or façades come out frayed; lower it if spikes survive.

## Cross-view consistency
<!-- param: geomConsistency  default: on -->
Keep it on. Once all maps exist, each depth is checked against the overlapping maps and
removed when they don't confirm it ([geometric consistency](help:geometric-consistency)).
This removes most errors on sky, foliage, water and silhouettes, in the saved maps
themselves.

## Agreement tolerance
<!-- param: maxGeomCost  default: 1.0 px -->
How far, in working pixels, a depth may land from itself after the round trip through
another view and still agree. Raise it to about 2 px when poses or calibration are
slightly off (scanned film) and the check removes most of every map.

## Consistent views
<!-- param: minConsistent  default: auto (1 object capture, 2 aerial / mapping) -->
How many other views must confirm a pixel. Blank follows the project type: 1 for an
object capture (fills more of walls and plain surfaces), 2 for aerial (removes glints
on water and stray points in the sky). Raise it for a cleaner, sparser result; images
with fewer neighbours use what they have.

## Minimum parallax
<!-- param: minGeomAngleDeg  default: 3° -->
Only views that see a point at least this angle apart may confirm it, since a view
from nearly the same spot "agrees" with any depth, sky included. Lower it only for very
short baselines such as a slow video sweep.

## Minimum NCC
<!-- param: minNcc  default: 0.1 -->
Drops pixels whose best matches correlate below this
([photometric consistency](help:photometric-consistency)). Raising it also removes
weak-texture surfaces such as water and plain roofs, so raise it in small steps.

## Compute and memory
With WebGPU (Settings ▸ Compute), the graphics card computes the maps; otherwise they
are spread over all CPU workers, each with its share of the memory budget, and the log
says how many. When the GPU is slow (integrated graphics), one map is also tried on the
CPU and the run continues on the faster; **Method ▸ Fast** then saves most of the time.
If the GPU's results on the first map disagree with the CPU's (a faulty driver), the
run moves to the CPU and the log says so.
Each map is saved as soon as it is done, so the image count doesn't multiply memory.
If the browser runs out of memory, lower the quality first.

## Limit the area
With a **Region** set (**Tools ▸ Model ▾ ▸ Region**, see
[Image Quality, Region and Orientation](guide:model-tools)), depths are searched only
inside it, images that see little of it are skipped, and fusion drops what lies
outside.

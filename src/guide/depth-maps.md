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

The depth map shown over an image is the one PatchMatch produced (after the speckle
filter), from before **Cross-view consistency** runs. Its colours stretch from the nearest depth (red) to the farthest
(blue) in that one map. Scattered dots in another colour are usually pixels the
cross-view check removes before fusion. They are common in bare trees, on water and
on low-texture ground such as ploughed fields, and are not a sign of a failed run.

## Quality
<!-- param: quality  default: Medium -->
**Medium** runs at one-quarter native resolution and is the normal starting point.
Low is useful for a preview; High and Ultra preserve finer detail but increase runtime
and memory sharply. Resolution cannot create texture that is absent from the photos.
If the chosen quality would not fit the memory budget, the run steps down to one that
does (see **Compute and memory** below). A **Working resolution override** under
Advanced settings replaces the resolution the quality card would choose; the cards then
say so. Picking a card clears the override.

## Speckle / median filter
<!-- param: speckleFilter  default: on -->
Cleans each depth map on its own, right after it is computed. Every depth is compared
with the median of its 3×3 neighbourhood: a pixel that differs by more than the
**Speckle tolerance**, or that has fewer than four valid neighbours, is dropped, and the
survivors are replaced by that median. This removes flying pixels and single-pixel
noise cheaply, at the cost of a slight smoothing of very fine relief. Keep it on; turn
it off only to inspect the raw PatchMatch output.

## Speckle tolerance
<!-- param: filterRelTol  default: 10% -->
How far, relative to the local median depth, a pixel may stray before the speckle
filter drops it. Lower values clean more aggressively but also erode depth edges and
steep, oblique surfaces, where depth legitimately changes within a few pixels. Raise it
if roof edges or façades come out frayed; lower it if isolated spikes survive into the
cloud.

## Cross-view consistency
<!-- param: geomConsistency  default: on -->
Keep this enabled for normal work. Once all maps exist, it projects each depth
estimate into the other maps and back, and removes pixels that the other views do not
confirm (see [geometric consistency](help:geometric-consistency)). This is particularly
important for sky, foliage, water, haze, and silhouettes, where a photometric score
alone can look deceptively good. Rejected pixels are removed from the saved maps
themselves, so the orthophoto benefits too. The four settings below tune the check;
switching it off also skips the **Minimum NCC** floor.

## Agreement tolerance
<!-- param: maxGeomCost  default: 1.0 px -->
How far, in working-resolution pixels, a depth may land from where it started after
the round trip through another view's own depth map. That view only counts as agreeing
within this distance. Lower values make cleaner but sparser maps. Raise it (to about
2 px) when camera poses or calibration are slightly off, for example with scanned film,
and the check removes most of every map; the
[reprojection error](help:reprojection-error) of the sparse model is a guide.

## Consistent views
<!-- param: minConsistent  default: 2 -->
How many other views must agree before a pixel is kept. With the default 2, a surface
has to be seen in at least three images, which removes anything only a single
neighbour happens to confirm. An image that overlaps fewer other images than this,
such as either photo of a two-image project, is checked against the views it has
instead (at least one), so it never comes out empty for lack of witnesses; the log
says how many maps this applied to. Images with enough overlapping views keep the
full count everywhere, so a strip near their edge that only one neighbour sees is
still removed; set 1 to keep such strips. Raise it for a cleaner but sparser result
on heavily-overlapping sets.

## Minimum parallax
<!-- param: minGeomAngleDeg  default: 3° -->
Decides which views may vote. A view taken from almost the same spot sees along the
same ray, so it "agrees" with any depth, including a sky pixel at an arbitrary
distance. Only views that see the point at least this angle apart (their
[baseline](help:baseline) relative to the distance) count. Lower it (or set 0) only
for sets shot with very short baselines, such as a slow video sweep, and check that
the background does not come back.

## Minimum NCC
<!-- param: minNcc  default: 0.1 -->
An absolute floor on each pixel's [photometric consistency](help:photometric-consistency):
pixels whose best matches correlate below this NCC are dropped before the cross-view
vote. It is the filter that vets the photometry; the dense cloud's matching-cost gate
is only a loose backstop above it. Raising it removes weakly textured surfaces
(water, shadows, plain roofs) along with genuine mismatches, so raise it in small steps.
Vegetation and sky often correlate well, so this floor cannot remove them; the
cross-view vote does.

## Working resolution override
<!-- param: maxDim  default: auto -->
Fixes the long side of the images PatchMatch works on, in pixels, instead of deriving
it from **Quality**. Leave it blank normally. Unlike Quality, an override is not
stepped down to fit the memory budget: if the estimate exceeds the budget, the run
stops before it starts. Use it to reproduce an earlier run exactly, or to pick a
resolution between two quality steps.

## Source views per image
<!-- param: maxSources  default: 6 -->
How many neighbouring cameras may support each reference image. More sources improve
the chance of finding useful baselines but cost more. Very oblique, distant, or
non-overlapping sources add little.

## Sources aggregated (best-K)
<!-- param: bestK  default: auto -->
For each pixel and depth hypothesis, PatchMatch scores every source view and averages
only the K best scores. A small K tolerates occlusion: a source that cannot see the
point does not drag the score down. A larger K averages more evidence and is less
noisy where every source sees the surface. Blank picks about half of each image's sources, between 1 and
4; set it only when diagnosing occlusion artefacts or noise.

## Patch window radius
<!-- param: window  default: 3 -->
Half-size of the patch PatchMatch compares between images (its
[photometric consistency](help:photometric-consistency) score): radius 3 compares 7×7 pixels.
A larger window is steadier on weak texture but smooths small detail and costs more
time per pixel. A smaller one keeps sharp edges but is noisier on plain surfaces.

## Iterations (per level)
<!-- param: iterations  default: 3 -->
How many propagation and refinement sweeps [PatchMatch](help:patchmatch) runs at the
finest resolution level; each coarser level gets one more. More iterations let good
depths spread further and improve weakly textured areas, at a roughly linear time
cost. The default three is a good first pass.

## Compute and memory
WebGPU acceleration is experimental and configured under Settings → Compute. With it,
one worker feeds the graphics card. Without it, the depth maps run on the processor,
spread over the parallel workers (Settings → Compute), each with its share of the
memory budget; the log says how many. The maps are the same either way. The
memory a run needs is estimated before it starts. If the chosen **Quality** would
exceed the memory budget (Settings → Compute), the run steps down to the highest
quality that fits (High → Medium → Low) and the log gives both estimates. A
**Working resolution override** is not stepped down: if it does not fit, the run
stops before starting. The worker may also reduce concurrency. Each depth map is
saved to the project as soon as it is finished and then released, so the number of
images no longer multiplies the memory a run needs. The cross-view check runs
afterwards as its own pass over the saved maps (the log's "Depth filter" lines), and
a run stopped halfway leaves no half-finished set behind: the maps of an interrupted
run are not offered to the dense cloud. If the browser runs out of memory, lower
quality first; this has the clearest effect on both memory and time.

## Limit the area
If a **Region** is set (**Tools → Model ▾ → Region**, see
[Image Quality, Region and Orientation](guide:model-tools)), each image's depth search
only covers the sparse points inside it. Images that see little of the region are
skipped quickly, and the far background is never searched. Fusion then drops anything
outside the box. A region drawn on an older model is ignored, and the log says so.

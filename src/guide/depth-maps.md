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
A [disabled](guide:getting-started) image gets no depth map and is no source view.

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

## Working resolution override
<!-- param: maxDim  default: auto -->
Fixes the long side of the images PatchMatch works on, in pixels, instead of deriving
it from **Quality**. Leave it blank normally. Unlike Quality, an override is not
stepped down to fit the memory budget: if the estimate exceeds the budget, the run
stops before it starts. Use it to reproduce an earlier run exactly, or to pick a
resolution between two quality steps.

## Source views per image
<!-- param: maxSources  default: 10 -->
How many neighbouring cameras may support each reference image. More sources improve
the chance of finding useful baselines but cost more. Very oblique, distant, or
non-overlapping sources add little. Ten fill noticeably more of the surface than six on
close-range scenes with many viewpoints; on a nadir block most images have that many
neighbours anyway.

## Sources aggregated (best-K)
<!-- param: bestK  default: auto -->
For each pixel and depth hypothesis, PatchMatch scores every source view and averages
only the K best scores. A small K tolerates occlusion: a source that cannot see the
point does not drag the score down. A larger K averages more evidence and is less
noisy where every source sees the surface. Blank picks about half of each image's sources, between 1 and
4; set it only when diagnosing occlusion artefacts or noise.

## Keep valid depth maps
<!-- param: keepMaps  default: on -->
Shown once depth maps are saved. A saved map is kept when its camera has not moved and
the settings that shape a map (quality, method, views, filters) are the ones it was made
with; only the others are computed. After [Add to the model](guide:sparse-reconstruction)
with Existing cameras ▸ Fixed, that is the new images' maps alone, so adding ten photos
to a large block costs ten maps. The check across views then runs over every map, so the
kept ones are checked against the new ones too, but they are not computed again with the
new images as neighbours, which a full run would do: turn it off for that. A rebuilt
model moves every camera, so nothing can be kept after one.

## Method
<!-- param: method  default: Auto -->
**Full** runs three stages, after Xu & Tao (2019, 2020):

1. **ACMH view selection:** candidate depths come from eight regions around each pixel,
   from right next to it to 23 pixels away, and are scored on the views in which most of
   them match well. Good depths spread across a surface faster, and a view that sees
   something else there, such as an occluding object, is left out.
2. **Planar priors:** the confident pixels of each map are joined into triangles, and a
   second pass is pulled towards each triangle's plane. A plain wall between textured
   edges gets the plane its edges define.
3. **Geometric consistency:** a last pass prefers depths that agree with the neighbouring
   maps.

**Fast** scores each candidate on its K best-matching views, in one pass. On the ETH3D
benchmark Full gave a more accurate and more complete cloud on every scene (F1 at 2 cm
62.0 → 66.2), for about 2–3× the depth-map time on a GPU and several times that without
one. **Auto** uses Full on the GPU and Fast on the CPU.

## Patch window radius
<!-- param: window  default: 3 -->
Half-size of the patch PatchMatch compares between images (its
[photometric consistency](help:photometric-consistency) score): radius 3 compares 7×7 pixels.
A larger window is steadier on weak texture but smooths small detail and costs more
time per pixel. A smaller one keeps sharp edges but is noisier on plain surfaces. The
pixels in the window are weighted by how close they are to its centre and how similar
their grey value is, so the far side of an object's edge counts little. On the ETH3D
benchmark a larger window still scored lower than the default.

## Iterations (per level)
<!-- param: iterations  default: 5 -->
How many propagation and refinement sweeps [PatchMatch](help:patchmatch) runs at the
finest resolution level; each coarser level gets one more. More iterations let good
depths spread further and improve weakly textured areas, at a roughly linear time
cost. Five sweeps fill more of the weakly textured areas than three; lower it for a
quick first look.

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
themselves, so the orthophoto benefits too. Each map is checked against at most 12
of the maps that overlap it: the nearest ones that see it from a different enough
angle, since a camera right beside it can confirm nothing. The four settings below
tune the check; switching it off also skips the **Minimum NCC** floor.

## Agreement tolerance
<!-- param: maxGeomCost  default: 1.0 px -->
How far, in working-resolution pixels, a depth may land from where it started after
the round trip through another view's own depth map. That view only counts as agreeing
within this distance. Lower values make cleaner but sparser maps. Raise it (to about
2 px) when camera poses or calibration are slightly off, for example with scanned film,
and the check removes most of every map; the
[reprojection error](help:reprojection-error) of the sparse model is a guide.

## Consistent views
<!-- param: minConsistent  default: auto (1 object capture, 2 aerial / mapping) -->
How many other views must agree before a pixel is kept. Left blank it follows the
project type. For an **object capture** it is 1: a surface seen in two images is kept,
which fills far more of walls, floors and plain surfaces (on the ETH3D benchmark the
F1 score at 2 cm rose from 57.1 to 62.0, with every scene better, at a small cost in
accuracy). For **aerial / mapping** it is 2: a surface has to be seen in at least three
images, which removes anything only a single neighbour happens to confirm, such as
glints on water and isolated points in the sky. An image that overlaps fewer other images than this,
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

## Compute and memory
WebGPU acceleration is experimental and configured under Settings → Compute. With it,
one worker feeds the graphics card. Without it, the depth maps run on the processor,
spread over the parallel workers (Settings → Compute), each with its share of the
memory budget; the log says how many. The maps are the same either way.

The graphics card gets its work in short pieces, so a laptop's integrated graphics,
which also draw the screen, keep it responsive, and the system does not reset the card
for a long command. When a map takes long on the card (over 8 s; the first is not
judged, as it also prepares the card), the next one is computed on the processor to
compare, and the run goes on with whichever was faster; the log says which, and the
choice holds until the page is reloaded. On such a laptop the processor is often the
faster: **Method ▸ Fast** then saves most of the time. The
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

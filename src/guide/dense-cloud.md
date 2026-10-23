---
id: dense-cloud
title: Dense Cloud
summary: Fuses consistent depth-map samples into a coloured point cloud with normals.
category: Dense reconstruction
order: 60
---
Fusion is Stage B of dense reconstruction. It cross-checks depth maps, merges agreeing
samples, and emits a coloured [point cloud](help:point-cloud) with normals for meshing.

## Point density
<!-- param: step default: 1 px -->
Emit one point every N depth-map pixels. `1` keeps full available density. A larger
step is a direct, predictable way to make a smaller point cloud for preview or export. If
the cloud would not fit the memory budget, fusion raises the step on its own (up to
4 px) and says so in the log.

## Auto thresholds
<!-- param: auto default: Enabled -->
Auto picks the minimum view count from the number of depth maps and uses the default
maximum matching cost (0.8). The cost gate is deliberately loose: the depth maps have
already been checked for photometric and cross-view agreement, and a stricter gate
mostly removes real surface, leaving holes rather than a cleaner cloud. Leave Auto on
unless you are diagnosing a specific completeness-versus-noise tradeoff. If the log
warns of a "weak cost distribution", most pixels match poorly: check the camera
calibration and the depth-map resolution before tightening fusion.

## Min consistent views
<!-- param: minViews  default: 2 -->
Shown when **Auto thresholds** is off. A depth-map pixel becomes a point only if this
many *other* depth maps see a surface at the same depth there, within the **Depth
agreement tolerance**. Auto uses 2, or 1 when there are only two depth maps. Raise it
for a cleaner, sparser cloud from heavily overlapping images; lower it to 1 to keep
areas that only two photos cover, such as the edges of a block, at the cost of more
noise there.

## Depth agreement tolerance
<!-- param: depthTolPct default: 1.0% -->
How closely reprojected depths must agree. Lower values make a cleaner, sparser cloud;
higher values retain more surface but can thicken edges and duplicate layers.

## Max matching cost
<!-- param: maxCost  default: 0.8 -->
Shown when **Auto thresholds** is off. Pixels whose PatchMatch
[matching cost](help:photometric-consistency) (1 − NCC: 0 is a perfect match, 2 none)
is above this are skipped before the consistency check. Auto uses the same 0.8. The
depth maps' **Minimum NCC** floor has already vetted the photometry, so this gate is
deliberately loose: lowering it mostly removes real but weakly textured surface and
leaves holes. Tighten it only to test whether noise comes from poorly matched pixels.

## Geometric outlier filters
These three filters run during fusion, after the consistency check, and remove
points that agree for the wrong reasons. Keep the defaults unless they remove a real
thin structure you care about.

## Min triangulation angle
<!-- param: minTriAngleDeg  default: 2° -->
A point is kept only if at least one agreeing depth map sees it from this angle or
more away from the reference image. Views from nearly the same spot agree with any
depth, so sky and distant haze pass the consistency check at almost zero
[baseline](help:baseline); this gate removes them. It repeats, more loosely, the
depth maps' **Minimum parallax** filter. Set 0 to disable it, for example for a
video sweep with very short baselines, and check that the background does not
return.

## Max surface incidence angle
<!-- param: maxIncidenceDeg  default: 80° -->
Drops points whose [surface normal](help:surface-normal) is turned more than this
angle away from the viewing ray, that is, surfaces seen almost edge-on. Depth is least
reliable there, and edge-on views produce the fuzzy shells around thin vegetation and
silhouettes. Lowering it cleans these more strongly but also removes steep surfaces
such as walls in nadir aerial images; 0 or 90 disables it. Points from depth maps
cached without normals are not affected.

## Remove isolated points
<!-- param: removeIsolated  default: on -->
After merging, drops points that are backed by only one or two depth-map pixels and
have fewer than two other points in the 3×3×3 block of merge cells around them. These are typically lone flyers from
sky or vegetation that slipped through the other gates. Well-supported points are
never tested, so the filter rarely touches real surface; turn it off only if a sparse,
thin structure (a wire or mast) loses points.

## Cleaning the cloud
Use the 3D viewer to inspect floating clusters, edge shells, holes, and over-smoothed
areas. A cloud of 4 million points or more is drawn level of detail: right after it is
made or imported, an octree of it is built in the background (the log says when), and
from then on the view shows a point budget's worth of it, the part in front of you in
most detail. While a selection tool is on, the whole cloud is drawn again, so every
point can be selected. Cloud filtering can remove statistical outliers or isolated components, but
systematic defects are better fixed in the depth maps, masks, or source imagery.

To remove points by hand, pick **Select (rectangle)** or **Select (lasso)** in
**Tools → Point Cloud ▾** (from another view this brings the 3D view forward), then
drag around the points in the 3D view. The **Select points** toolbox over the view shows
the count and the Delete / Keep only / Clear buttons. Shift-drag adds to the selection,
Alt-drag removes from it, and a plain click clears it. Selected points turn pink.
Then choose **Delete** (or press Delete) or **Keep only**. Esc while dragging
abandons that shape; otherwise Esc clears the selection, and a second Esc leaves the
tool. Cancelling an edit that spans several clouds stops after the current cloud.

To fix a classification by hand instead, choose a class in the toolbox's **Class to
assign** list and click **Assign class**: the selected points take that LAS class
(ground, building, vegetation, water, noise) and every other point keeps its own. A
cloud without classes starts with every point "never classified" (class 0). The
result opens coloured by class, and the classes go out with LAS, LAZ and PLY exports.
Reclassifying follows the same non-destructive rule as deleting: a computed or
imported cloud gets a "(classified)" copy, a copy is refined in place.
The first edit keeps your current view. Orbit, pan and zoom keep working on the other mouse
buttons and the wheel while a tool is active.

- Selection goes **through** the cloud: points hidden behind a surface inside the
  shape are selected too, and stay highlighted so you can see them. Rotate the view
  first if you only want the front layer.
- Only **dense** clouds are selectable. Points you cannot see are never selected:
  points hidden by the cloud's style (for example, a hidden class), and points cut
  away by the near-clip setting. Changing the style clears an existing selection.
  **Keep only** still removes every point outside the selection, hidden ones
  included.
- Editing is non-destructive. The first edit of a computed or imported cloud adds an
  "(edited)" copy and hides the original in the sidebar. Further edits refine that
  copy in place, so repeated cleanup doesn't stack full copies in memory. To start
  over, delete the copy and show the original again.


## Saved depth maps and memory
Depth maps are saved one by one as they finish, and their pixel arrays are released
(a project that cannot use browser storage keeps them in memory instead). Building a dense
cloud reads one reference map and one comparison map at a time; orthophoto
generation reads one map at a time. The same consistency and blending rules apply.
This reduces resident input memory, though the merged point cloud and its output
still need memory. Unsaved maps remain in memory if project storage is unavailable.
Streaming may trade repeated disk reads for a lower memory peak.

Fusion starts by planning: a few quick passes over every depth map for the cost
statistics, the scene's extent and the merge cell, shown in the progress bar as
"Planning fusion (1/4)" and so on. On a few hundred saved maps this takes a minute or
two. The last planning pass comes before the slow consistency check: it counts how many merged points the cloud can have at most (pixels that fail the
cost gate or lie outside the Region don't count). The log line "Fusion: measured …
projected peak …" shows that count and the memory it implies. If building the cloud
in one piece would exceed the memory budget (Settings ▸ Compute), fusion builds it in
slabs along the scene's longest axis instead ("fusing in N slabs"), keeping only one
slab's working memory at a time. The cloud is identical either way; the slabs only
cost extra reading time, because a depth map that reaches two slabs is read for both.
If the finished cloud itself cannot fit (it is held twice while the slabs are
joined), fusion re-plans at double the sample step, a quarter of the pixels, and
warns in the log; it tries again up to a step of 4 px. Only if that still does not fit
does fusion stop, and nothing is lost. To get under the budget yourself: raise
**Point density (sample step)**; set a Region around the subject (Tools ▸ Model); or
build the depth maps at a lower Quality. Raise the budget only if the machine really has that much free
memory. After fusion, a second log line compares the real point count with the
measured limit.

The consistency check compares each depth map with the views that can see it, nearest
camera first, and keeps checking only the pixels not yet confirmed, so most pixels are
settled after a few views. The order doesn't change the result. At the end, the log
line "Fusion timing" shows where the time went: reading maps, the consistency check,
the fusion pass and finishing.

The browser sets limits of its own, however much memory the machine has. A Chrome tab
holds at most 16 GB of buffers, shared by the page and all its workers, and a single
buffer at most 2 GB, so every run keeps at most 12 GB of the memory budget in buffers,
leaving the rest for the images, clouds and viewer. Fusion keeps its merge cells, and a
finished cloud past 2 GB, in WebAssembly memory instead, which neither limit applies
to: it may use the whole budget (Settings ▸ Compute, up to the memory the browser
reports). In Chrome one piece of fusion then holds up to about 1.07 billion merge cells
and a finished cloud up to about 1.4 billion points, as far as the budget allows; a
larger cloud is re-planned at a coarser step, as above. A browser without 64-bit
WebAssembly memory holds about half the cells and a quarter of the points, and a page
that is not cross-origin isolated keeps the cloud to about 178 million points. A cloud
of more than 178 million points is drawn through its octree, so it shows once the octree
is built. Fusion starts with fresh workers, so memory the previous steps left behind is
returned first.

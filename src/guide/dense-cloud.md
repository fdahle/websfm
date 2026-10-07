---
id: dense-cloud
title: Dense Cloud
summary: Fuses consistent depth-map samples into a coloured point cloud with normals.
category: Dense reconstruction
order: 60
---
Fusion is Stage B of dense reconstruction. It cross-checks depth maps, merges agreeing
samples, and emits a coloured [point cloud](help:point-cloud) with normals for meshing.

## Auto thresholds
<!-- param: auto default: Enabled -->
Auto derives the minimum view count and maximum PatchMatch cost from the current data.
Leave it on unless you are diagnosing a specific completeness-versus-noise tradeoff.

## Depth agreement tolerance
<!-- param: depthTolPct default: 1.0% -->
How closely reprojected depths must agree. Lower values make a cleaner, sparser cloud;
higher values retain more surface but can thicken edges and duplicate layers.

## Point density
<!-- param: step default: 1 px -->
Emit one point every N depth-map pixels. `1` keeps full available density. A larger
step is a direct, predictable way to make a smaller cloud for preview or export.

## Geometric outlier filters
Minimum triangulation angle removes near-parallel evidence such as sky and distant
haze. Maximum incidence angle removes surfaces seen almost edge-on. Isolated-point
cleanup targets unsupported fusion flyers. Keep the defaults unless they remove a
real thin structure you care about.

## Cleaning the cloud
Use the 3D viewer to inspect floating clusters, edge shells, holes, and over-smoothed
areas. Cloud filtering can remove statistical outliers or isolated components, but
systematic defects are better fixed in the depth maps, masks, or source imagery.

To remove points by hand, pick **Rectangle** or **Lasso** in the ribbon's
**View → Select** group (or **Tools → Point Cloud ▾ → Select points**), then drag
around the points in the 3D view. The **Select points** toolbox over the view shows
the count and the Delete / Keep only / Clear buttons. Shift-drag adds to the selection,
Alt-drag removes from it, and a plain click clears it. Selected points turn pink.
Then choose **Delete** (or press Delete) or **Keep only**. Esc while dragging
abandons that shape; otherwise Esc clears the selection, and a second Esc leaves the
tool. Cancelling an edit that spans several clouds stops after the current cloud.
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
After depth maps are saved, their pixel arrays are released. Building a dense
cloud reads one reference map and one comparison map at a time; orthophoto
generation reads one map at a time. The same consistency and blending rules apply.
This reduces resident input memory, though the merged point cloud and its output
still need memory. Unsaved maps remain in memory if project storage is unavailable.
The memory estimate shown before fusion includes the streamed inputs and scratch
arrays. Streaming may trade repeated disk reads for a lower memory peak.

---
id: dense-cloud
title: Dense Cloud
summary: Fuses consistent depth-map samples into a coloured point cloud with normals.
category: Dense reconstruction
order: 60
---
Fusion is the second stage of dense reconstruction. It merges the depth-map pixels that
several maps agree on into a coloured [point cloud](help:point-cloud) with normals.

## Point density
<!-- param: step default: 1 px -->
One point every N depth-map pixels. `1` keeps full density; a larger step gives a
smaller cloud for previews or export. If the cloud wouldn't fit the memory budget,
fusion raises the step itself (up to 4 px) and says so.

## Auto thresholds
<!-- param: auto default: Enabled -->
Picks the view count from the number of depth maps and keeps a loose cost gate, since
the depth maps are already checked. Leave it on unless you are diagnosing noise against
completeness. A "weak cost distribution" warning points at calibration or depth-map
resolution, not at fusion.

## Min consistent views
<!-- param: minViews  default: 2 -->
With Auto off: how many other depth maps must see the same depth for a pixel to become
a point. Raise it for a cleaner, sparser cloud; 1 keeps areas only two photos cover,
such as block edges, with more noise.

## Depth agreement tolerance
<!-- param: depthTolPct default: 1.0% -->
How closely the depths must agree. Lower gives a cleaner, sparser cloud; higher keeps
more surface but can thicken edges and double layers.

## Max matching cost
<!-- param: maxCost  default: 0.8 -->
With Auto off: pixels that matched worse than this
([matching cost](help:photometric-consistency), 0 perfect – 2 none) are skipped.
Lowering it mostly removes real weak-texture surface; tighten it only to test where
noise comes from.

## Geometric outlier filters
Three filters during fusion remove points that agree for the wrong reasons. Keep the
defaults unless they remove a thin structure you need.

## Min triangulation angle
<!-- param: minTriAngleDeg  default: 2° -->
A point needs a confirming view at least this angle away. Views from nearly the same
spot confirm any depth, which lets sky and haze through. Set 0 only for very short
[baseline](help:baseline)s such as a slow video sweep.

## Max surface incidence angle
<!-- param: maxIncidenceDeg  default: 80° -->
Drops points on surfaces seen almost edge-on (their
[surface normal](help:surface-normal) more than this from the view), where depth is
least reliable: the fuzzy shells around vegetation and silhouettes. Lower values also
remove walls in nadir blocks; 0 or 90 disables it.

## Remove isolated points
<!-- param: removeIsolated  default: on -->
Drops weakly supported points with almost no neighbours, typically lone flyers from
sky or vegetation. Turn it off only if a thin structure such as a wire loses points.

## Replace the main dense cloud
<!-- param: replaceMain default: Off -->
Off, the new cloud is added beside the others ("Dense cloud 2") and becomes the
[main dense cloud](help:main-product). On, it takes the main one's place and name; an
imported or edited main cloud is never replaced. Products built on the old cloud are
kept and marked outdated.

## Cleaning the cloud
Inspect the cloud in the 3D view for floating clusters, edge shells and holes. Clouds of
4 million points or more are drawn level of detail, the nearest part finest. Systematic
defects are better fixed in the depth maps, masks or images than by filtering.

To clean by hand, pick **Select (rectangle)** or **Select (lasso)** in **Tools → Point
Cloud ▾** and drag around points in the 3D view. Shift adds, Alt removes, a click
clears; selected points turn pink. **Delete** or **Keep only** acts on them, and
**Assign class** gives them a LAS class instead. Selection goes through the cloud, so
rotate first if you only want the front layer; hidden points are never selected. The
first edit makes an "(edited)" copy and hides the original; later edits refine that
copy.

## Saved depth maps and memory
Fusion reads the saved depth maps a few at a time rather than holding them all. It
first plans and logs the largest cloud it can produce and the memory that needs. If
that exceeds the budget (Settings ▸ Compute), it builds the cloud in slabs, spread over
several workers, with the same result; if even the finished cloud won't fit, it doubles
the point step and warns. To fit yourself: raise **Point density**, set a Region
(Tools ▸ Model), or build the depth maps at a lower Quality. The log's "Fusion timing"
line shows where the time went.

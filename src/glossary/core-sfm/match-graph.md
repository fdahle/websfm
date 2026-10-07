---
id: match-graph
title: Match Graph
aliases: match graphs, image graph, view graph, connectivity graph
summary: The graph whose nodes are images and whose edges are verified matched pairs — the connectivity that determines what can be reconstructed at all.
---
The **match graph** has one node per image and one edge per verified image pair,
weighted by how many inlier matches that pair survived with. It is the structural
summary of the whole matching stage, and reading it explains most reconstruction
failures faster than any error statistic.

The rule it enforces is blunt: **only a connected component can be
reconstructed**. Images in a separate component share no observations with the
main model, so no chain of [tracks](help:track) reaches them and no amount of
[bundle adjustment](help:bundle-adjustment) will bring them in. If a survey
splits into two components, the outcome is two reconstructions in unrelated
coordinate frames, not one incomplete one.

<!-- TODO(image): assets/match-graph.svg - an image graph with edge thickness by inlier count, showing one dense cluster, a second component fully detached, and a single fragile bridge edge whose removal would split the graph - each of the three annotated. -->

Three properties matter when reading it:

- **Components.** How many disconnected groups exist, and which images ended up
  isolated. An unregistered image is nearly always a graph problem, not a solver
  problem.
- **Bridge edges** (articulation edges, "fragile links"). A single edge whose
  removal disconnects the graph is a structural weakness: one long strip joined
  to another by one pair means the entire relative geometry of the two halves
  rests on that pair being correct.
- **Density.** Many redundant edges give bundle adjustment cycles to average
  errors around; a chain-like graph has none, and drifts.

**Verified does not mean true.** Repetitive structure — a snowfield, a regular
façade, ocean texture — can produce a pair that passes every count and inlier
test while relating two images that do not overlap at all. Such a pair cannot
register a camera on its own: registration needs 2D–3D correspondences that agree
with points the rest of the graph already built, and the track filter and robust
bundle adjustment reject observations that disagree with the model.
[Cycle consistency](help:cycle-consistency) is the classic graph-level check, but it
is only as reliable as the pairwise rotations it composes.

Pairs can also be **disabled by hand** from the match list or the graph view — a
reversible exclusion for a pair that is visibly wrong. Disabled pairs stop
contributing everywhere the reconstruction reads the graph.

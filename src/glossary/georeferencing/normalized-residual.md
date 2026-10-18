---
id: normalized-residual
title: Normalized Residual
aliases: normalized residuals, normalised residual, normalised residuals, Baarda, leave-one-out, LOO
summary: A point's misfit divided by how large its misfit is expected to be — near 1 is normal, well above 3 points at a bad mark or coordinate.
---
A **normalized residual** divides a point's misfit by the size of misfit its
uncertainty predicts, so points with very different accuracies can be judged on one
scale. A value near **1σ** is what the declared accuracies lead you to expect; above
about **3σ** the point, its coordinates or its image marks deserve a look.

The expected misfit depends on what the point did in the fit:

- A **control** point helped make the [georeference](help:georeferencing), so the fit
  has already moved towards it and its residual is *smaller* than its own accuracy.
  Its residual is divided by its declared covariance **less** what the fit absorbs
  (Baarda's redundancy). With only a few controls this matters: four controls leave
  each one roughly a third less room, and dividing by the full accuracy would make a
  bad control look fine.
- A **checkpoint** took no part in the fit, so its misfit is its own error **plus**
  the fit's uncertainty at that spot; its residual is divided by both together.
- **Leave-one-out (LOO)** refits without one control and predicts it from the others,
  turning that control into a checkpoint for the moment: its declared covariance plus
  the uncertainty of the fit made without it.

All three use the declared [GCP](help:ground-control-point) accuracies as the
truth about the survey: if those are optimistic, every normalized residual reads high.
The uncertainty of the triangulated model point itself is not yet included.

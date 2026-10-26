---
id: magsac
title: MAGSAC++
aliases: MAGSAC, sigma-consensus
summary: A RANSAC variant that does not trust one inlier threshold: it scores a model by a loss averaged over every noise level up to a maximum, and polishes it by weighted least squares.
refs: barath2020
---
**MAGSAC++** (Barath et al., 2020) is a robust estimator in the
[RANSAC](help:ransac) family. It draws the same random minimal samples, but judges
and refines the models differently.

Plain RANSAC counts the matches that lie within a fixed tolerance of a model. Every
match inside the tolerance counts the same, whether it sits 0.1 px or 1.9 px from
its [epipolar line](help:epipolar-geometry), so two quite different models can score
alike, and the result depends on the threshold. MAGSAC++ treats the noise level as
unknown, anywhere between zero and a maximum, and averages over all of them. The
result is a smooth loss: a match close to the model costs almost nothing, the cost
rises with its distance, and every match beyond the maximum costs the same as any
other outlier. The model with the lowest total loss wins.

Each new best model is then polished by **σ-consensus++**: it is refitted by
weighted least squares, with weights that are high for matches close to the model and
fade to zero at the maximum, and the refit is repeated while the loss improves.
No hard boundary decides which matches shape the fit.

In WebSfM the threshold you set is the maximum. The matches kept for a pair are
still those within it of the final model, so inlier counts mean the same with
either estimator.

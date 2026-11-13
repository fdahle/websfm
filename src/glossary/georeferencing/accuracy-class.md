---
id: accuracy-class
title: Accuracy Class (ASPRS)
aliases: accuracy class, ASPRS, RMSE_H, RMSE_V, positional accuracy class
summary: The RMSE a survey delivery is stated against at independent checkpoints, after the ASPRS Positional Accuracy Standards (Edition 2, 2023).
refs: asprs2023
---
The **ASPRS Positional Accuracy Standards** (Edition 2, 2023) state a data set's accuracy
as an RMSE at independent checkpoints: **RMSE_H** horizontally, from the east and north
RMSE, and **RMSE_V** vertically. A data set meets an **accuracy class** of, say, 5 cm when
its RMSE is 5 cm or less; the class is whatever the project asks for.

Edition 2 counts the checkpoints' own survey error into the result: the fit to the
checkpoints and the checkpoints' accuracy combine as √(RMSE₁² + RMSE₂²), so a 1 cm fit
to checkpoints surveyed at 2 cm is a 2.2 cm product. It asks for at least **30
checkpoints**, surveyed about twice as accurately as the product, a mean error well under
the RMSE (no systematic shift left), and treats a residual over three times the RMSE as a
blunder to explain.

WebSfM reports these figures in the Quality Report for the GCPs marked as checkpoints,
using their declared accuracies as the survey error. They describe the adjusted block: a
DEM or orthophoto built from it adds its own error.

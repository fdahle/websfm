---
id: optimize-cameras
title: Optimize Cameras
summary: Re-adjust the cameras and points of the sparse model with more of the camera calibration free, as Metashape's Optimize Cameras.
category: Tools
order: 135
---
**Tools ▸ Model ▾ ▸ Optimize cameras…** runs [bundle adjustment](help:bundle-adjustment)
on the sparse model again, with the calibration terms you choose free, as Metashape's
*Optimize Cameras* does. Use it after removing poor points with
[gradual selection](guide:sparse-reconstruction), or after adding control, when the
residuals suggest a slightly wrong calibration. It refuses a change over 20 % and a
solve that makes the residuals worse. Like gradual selection, it retires the depth maps
and the georeference.

## Free parameters
<!-- param: refine  default: Focal length -->
**Focal length** refines each camera group's focal length with the poses and points;
distortion stays as calibrated. **Focal length + principal point** also frees the
principal point, which needs a well-spread, strongly overlapping block with varied
viewing angles; on a single strip it drifts.

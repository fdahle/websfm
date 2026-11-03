---
id: reflectance-calibration
title: Reflectance Calibration
aliases: reflectance, calibration panel, reflectance panel, sun sensor, downwelling light sensor, DLS, radiance
summary: Turning what a camera measured (radiance) into what the ground reflects (reflectance), with a panel of known reflectance or a sensor that measures the incoming light.
refs: micasense2017
---
A camera measures **radiance**: the light that reaches each pixel. It depends on the
ground and on the sunlight, which changes with the time of day and every passing cloud.
**Reflectance** is the share of the incoming light the ground sends back, 0 to 1; it
belongs to the ground alone, so maps from different flights and days compare.

A multispectral camera records what it needs to compute radiance from its raw values:
black level, gain, exposure time, vignetting and a calibration per band. Two sources give
the incoming light:

- A **calibration panel** of known reflectance (its albedo per band, printed on it),
  photographed on the ground before or after the flight: reflectance = albedo ×
  radiance / the panel's radiance.
- A **sun sensor** (downwelling light sensor, DLS) on top of the drone, measuring the
  irradiance E at every photo: reflectance = π × radiance / E.

Combined, the panel sets the scale and the sun sensor follows the light through the
flight. A thermal band needs neither: its values are temperatures.

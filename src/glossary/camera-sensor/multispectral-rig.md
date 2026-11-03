---
id: multispectral-rig
title: Multispectral Camera
aliases: multispectral camera, multispectral, camera rig, band image
summary: A camera with one lens per spectral band, all triggered together. Each capture is one photo per band, and the lenses sit at fixed offsets from each other.
---
A multispectral camera such as a MicaSense RedEdge or Altum has a separate lens and
sensor for each band (blue, green, red, red edge, near infrared, often panchromatic and
thermal). One trigger makes a **capture**: one single-band image per lens, taken at the
same moment. The lenses are a few centimetres apart and turned slightly against each
other; the camera records these offsets per band, relative to a **reference band**.

WebSfM reads the bands and captures from the photos' metadata. Each band becomes its
own [sensor](help:sensor), because each lens has its own calibration. Captures the
camera took of its calibration panel are disabled when imported, so alignment leaves
them out.

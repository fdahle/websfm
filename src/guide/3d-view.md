---
id: 3d-view
title: The 3D View
summary: Move around the model, frame it with the view presets, and let it turn on its own — or record one turn as a video.
category: Start here
order: 5
---
The **3D** tab shows the sparse model, dense clouds and meshes in the project's own
coordinates. While it is in front, the ribbon's **View** tab adds two groups for it:
**Camera** (where you look from) and **Scene** (what is drawn and how big).

## Navigate
- **Drag** with the left mouse button to orbit around the centre of the view.
- **Drag** with the right button to pan.
- **Scroll** to zoom. The zoom heads for the point under the cursor and takes the orbit
  centre with it, so you can zoom into a detail and then orbit around it.
- **Double-click** a point of a cloud or a mesh to orbit around it: the view turns to it,
  at the same distance.

To bring one cloud or mesh into view, right-click it in the sidebar and choose
**Zoom to**.

## Camera and scene
- **Top**, **Bottom**, **Left**, **Right**, **Front** and **Back** look at the whole
  scene from that side, level with the scene's up direction (from the cameras, or
  from **Tools ▸ Model ▾ ▸ Orient model**). **Reset View** returns to the oblique
  overview. The number keys do the same: **7** top, **1** front, **3** right, **9** the
  opposite side of the last one, **0** the overview.
- **Orthographic** (key **5**) shows the scene without perspective: heights and distances
  read the same everywhere in the view, as in a plan, a profile or a façade drawing.
  Scroll zooms; the presets frame the whole scene. Press **5** again for perspective.
- **Save Image** saves the view as a PNG, as it is on screen.
- **Cameras**, **Grid** and **Legend** show or hide the camera frustums, the ground
  grid and the colour legend. The two steppers set the point size and the size of
  the camera frustums.
- The background colour, the grid's height and the point budget are in
  **Settings ▸ Map & 3D**; the near clipping distance is there too, with **Show
  advanced settings** on.

## Turntable
**View ▸ Camera ▸ Turntable** turns the camera slowly around the centre of the view,
about the scene's up direction, so the model turns on its own: for showing a result, or
for checking a dense cloud, where floating points and holes stand out once it moves.
Drag to steer at any time; the turn carries on from there when you let go. The
**Turntable** toolbox over the view sets the speed, and its × (or the ribbon button
again) stops it.

**Record one turn** saves one full, seamlessly looping turn as a video at the view's
size on screen; hide the grid or cameras first if needed. Chrome, Edge and Firefox save
WebM, Safari MP4; `ffmpeg -i in.webm out.mp4` converts for players that struggle with
WebM.

## Seconds per turn
<!-- param: secondsPerTurn  default: 24 -->
How long one full turn takes, and so the length of a recorded video. Slower turns look
calmer and give a large cloud time to load its detail as it comes into view; 20–30
seconds suits most models. The value is kept in this browser.

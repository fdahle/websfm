---
id: offline
title: Working Offline
summary: Install websfm, start it without a connection, and know which parts still need the network.
category: Start here
order: 4
---
websfm computes everything in the browser and keeps projects in local storage (see
[Projects & Storage](guide:projects-storage)), so a connection is needed only to fetch
the app itself and a few outside resources. After the first visit the browser keeps a
copy of the app; a short message, *websfm is ready to work offline*, says when it is
complete. From then on websfm starts without a connection, in a tab at the same
address or as an installed app.

## Install the app
Browsers that support it offer to install websfm, usually with an install icon in the
address bar or an **Install** item in the browser menu. The installed app opens in
its own window, without the browser's toolbars, and starts from the desktop or
start menu like any program. It is the same app at the same address: projects in
browser storage, settings and downloaded models are shared with the browser tab.
Installing is optional; a tab works offline just as well.

## Updates
websfm checks for a new version when it starts and then once an hour, and downloads
it in the background. It never switches until you ask: a box at the bottom left says
*A new version of websfm is available*.

- **Reload** switches to the new version now. While a task is running (a pipeline
  step, opening or saving a project, importing images) the button is disabled and
  the box says you can reload once the task has finished, so an update never cuts a
  run short.
- **Later** hides the box for this session. The new version is used the next time
  websfm starts after all its tabs and windows were closed.

With websfm open in several tabs, **Reload** in one switches all of them: an idle
tab reloads at once, and a tab still running a task keeps the box up and reloads by
itself once the task has finished. Once another tab has switched, **Later** is no
longer offered, since that tab's old code no longer matches the new version.

## What needs a connection
- **Learned models** (DISK, LightGlue, and the Smart Select model for
  [masks](guide:masks)) are downloaded on first use, after you agree, together with
  the runtime that executes them. The browser keeps them, so use them once while
  online if you will need them offline. A SuperPoint file you supply yourself is kept
  the same way. SIFT and the rest of the pipeline need no download.
- **Basemap tiles** for the 2D map come from online tile servers. Only part of what
  you viewed is kept; see below.
- **Coordinate systems** come from the built-in EPSG catalog of over 7,000
  [coordinate systems](help:coordinate-reference-system), which works offline: picking a
  CRS, and EPSG codes in imported files, projects, GCPs and poses. Only a code newer
  than the catalog is looked up on epsg.io. Offline, that fails with a message; once
  looked up, it is remembered.

## The 2D map offline
Map tiles are kept only for areas you have already viewed online, and only at the
coarser zoom levels (0 to 12, down to about 40 m per pixel at the equator). Nothing
is downloaded in advance: OpenStreetMap's tile policy forbids bulk downloading and
Esri's terms restrict offline use of its imagery. Each layer keeps a few hundred
tiles, up to 30 days; the oldest go first.

Offline, a project area you have seen before therefore comes back as a coarser,
upsampled image when you zoom in, and an area you have never viewed stays blank.
The map says *Offline: the basemap shows only areas viewed before, at lower detail*,
so a blurry or empty map is not mistaken for an error. When the connection returns,
the missing tiles load again by themselves.

- **Streets**, **Satellite** (Esri World Imagery) and **Terrain** are kept this way.
- **A satellite source of your own** (Settings) is never kept, so it is unavailable
  offline.
- **The polar layers** (NASA, for polar coordinate systems) are coarse, so every level
  is kept. If the layer cannot be set up offline, the map shows only the grid and
  says the polar basemap is unavailable until you reconnect.

If the map is online but tiles still fail, it says *Basemap tiles are not loading*:
the tile server is unreachable or blocked, not your project.

Your own data never depends on the basemap: cameras, GCPs, footprints, DEMs and
orthophotos are drawn from the project, online or not.

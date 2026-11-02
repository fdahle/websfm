---
id: offline
title: Working Offline
summary: Install WebSfM, start it without a connection, and know which parts still need the network.
category: Start here
order: 4
---
WebSfM computes everything in the browser and keeps projects in local storage (see
[Projects & Storage](guide:projects-storage)), so a connection is needed only to fetch
the app itself and a few outside resources. After the first visit the browser keeps a
copy of the app; a short message, *WebSfM is ready to work offline*, says when it is
complete. From then on WebSfM starts without a connection, in a tab at the same
address or as an installed app.

## Install the app
Browsers that support it offer to install WebSfM (an install icon in the address bar,
or **Install** in the browser menu). The app then opens in its own window from the
desktop or start menu, sharing projects, settings and models with the browser tab.
It's optional; a tab works offline too.

## Updates
WebSfM checks for a new version when it starts and then once an hour, and downloads
it in the background. It never switches until you ask: a box at the bottom left says
*A new version of WebSfM is available*.

- **Reload** switches now; while a task runs it waits, so an update never cuts a run
  short.
- **Later** keeps the old version until WebSfM next starts with all its tabs closed.

**Reload** in one tab switches all of them, each once its running task has finished.

## What needs a connection
- **Learned models** (ALIKED, DISK, LightGlue, and the Smart Select model for
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
  The geoid grids that convert between [vertical datums](help:vertical-datum) are
  part of the app and work offline too.

## The 2D map offline
Map tiles are kept only for areas viewed online, at coarser zoom levels (to about 40 m
per pixel), for up to 30 days; the tile providers' terms forbid downloading in advance.
Offline, a known area shows coarser and an unseen one stays blank, and the map says so.
Tiles load again when the connection returns.

- **Streets**, **Satellite** (Esri World Imagery) and **Terrain** are kept this way.
  [Footprints from poses](guide:footprints-from-poses) reads its ground heights from
  the same Terrain tiles, so offline it works only where they were kept.
- **A satellite source of your own** (Settings) is never kept, so it is unavailable
  offline.
- **The polar layers** (NASA) are coarse, so every level is kept.

Online tiles that fail to load are reported as *Basemap tiles are not loading*: the
server is unreachable, not your project.

Your own data never depends on the basemap: cameras, GCPs, footprints, DEMs and
orthophotos are drawn from the project, online or not.

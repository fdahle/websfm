---
id: import-project
title: Import a Project
summary: Brings another WebSfM project's photos, features and matches into this one, so two flights, two days or a colleague's block can be joined into one model.
category: Reconstruction pipeline
order: 11
---
**Import ▸ WebSfM Project…** copies another project into the open one: two flights or
two days processed apart, a large set split by hand, or a colleague's project of the
neighbouring area. The other project stays as it was. A colleague's `.websfm` file is
opened first (**Open existing ▸ Project file…**), which makes it a project you can
choose here.

What comes:

- **Photos**, with their **features** as that project detected them and the
  **matches** between them, so nothing has to be detected or matched again within the
  imported block. A photo both projects hold (the same file: name, size, pixel size
  and capture time) is kept once, with this project's features; the other project's
  matches on it stay behind. A photo whose name is taken by a different photo here
  gets a "(2)" after it.
- **Sensors.** One with exactly the same calibration as a sensor here joins it, so the
  same camera shares one calibration; any other comes in as its own sensor.
- **GCPs and markers**, joined by name: their image marks come, and a point that is
  already here keeps its position. **Imported camera positions** come with their photos
  (positions from the photos' EXIF are read again anyway). Masks come too.

What stays behind: the other project's model, depth maps, clouds, meshes and rasters.

The photos come a batch at a time, behind a progress bar. **Cancel** stops after the
batch under way: the photos already in stay, with their features, the pairs between
them and their marks, and importing the project again brings the rest (the photos
already here are recognised and kept once).

## Joining the photos to the model
The imported photos are matched among themselves, but not yet with this project's.
1. **Match Features** with **Match only new pairs** on (it starts on by itself here):
   only the pairs between the two blocks are matched.
2. **Sparse Reconstruction ▸ Add to the model** places the imported photos into the
   model. With **Existing cameras ▸ Fixed** this project's cameras stay where they are,
   and so do its depth maps, clouds and rasters; **Refined** lets every camera move
   with the new ones. Without a model yet, **Rebuild** makes one from all photos.

The two blocks must overlap for this: photos of the same ground, so the matcher finds
the same features in both. Blocks that only share GCPs, or lie side by side without
overlap, cannot be joined this way yet.

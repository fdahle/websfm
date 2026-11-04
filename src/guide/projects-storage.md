---
id: projects-storage
title: Projects & Storage
summary: Understand autosave, browser storage, folder-backed projects, storage running full, duplicating a project, and portable .websfm project files.
category: Start here
order: 2
---
WebSfM saves projects on your computer as you work; there is no upload or account, so
projects work offline (see [Working Offline](guide:offline)). Imported images are
copied into the project, so moving the originals later changes nothing.

The project list shows under each name where the project is kept (a folder or browser
icon), its CRS, its size and when it was edited. **Project settings ▸ Where it is
saved** has the buttons to move or export it.

## In this browser
The default is the browser's private storage: fast and needs no file handling, but tied
to this browser profile and site. Clearing site data or switching browsers loses it, so
export a project file of work you can't afford to lose. When the browser hasn't agreed
to keep the storage, the list's foot says so; **Ask the browser to keep it** asks again.

## In a folder
On Chrome, Edge and other Chromium browsers, a project can live in a normal folder on
your disk. Don't rename, move or edit its files while it is open. The photos are in its
`images` folder under internal ids; `images/index.csv` lists which is which. The browser
may ask you to reconnect the folder after a restart. **Move to folder…** and **Move to
browser storage** move a project between the two. When photos you add bring a project in
browser storage to 3 GB of photos or more, WebSfM asks once whether to move it to a
folder first, since its depth maps and products will take several times that.

## Duplicate a project
**Duplicate** in the project list's **⋯** menu copies a project, to try other settings
while keeping the original. A folder project is copied into another folder you choose.
The copy is independent and needs as much room as the original.

## When browser storage is full
When a save is refused for lack of space, WebSfM offers to move the project to a folder
on your disk, where the unsaved work and any running step continue. **Not now** leaves a
card at the lower left with the number of unsaved changes and **Move to folder…**; where
folders aren't possible, free space (delete a project, or clear derived data in
**Project settings**) and **Retry saving**. **Dismiss** drops the unsaved changes.

## Export project file
**Other ▸ Export Project** writes the whole project (images, features, matches, model,
clouds, meshes, control, measurements, settings) into one `.websfm` file, a copy to keep
or open elsewhere. **Include depth maps, DEMs, orthophotos and image previews** makes it
much larger; left out, those have to be built again. Files over 4 GB use ZIP64. In
Firefox and Safari the file is built in memory first, so save large projects without
derived data there. You can save while a step runs; if a file changes mid-save, the save
stops and says so.

## Open and switch projects
Opening a `.websfm` file (**Open existing ▸ Project file…**, or drop it on the window)
unpacks it into a new project, in this browser or in a folder. Features and matches are
read from storage when needed, so the first overlay after opening may take a moment.
A project from an older version is upgraded when opened (the console says how) and then
no longer opens in older versions; one from a newer version needs a page reload.

## When the tab closes during a run
Detect Features, Match Features and Build Depth Maps save as they go. If the tab closes
mid-run, reopening the project offers **Continue**, which does only the missing work
with the original settings, or **Discard**. A cancelled run is offered the same way.

## File name
Exports go to the browser's downloads folder; large point cloud and mesh exports in
Chrome and Edge ask where to save first. Each export dialog has an optional **File
name**; left empty, the file is named after the project and its contents. Sidecar files
(.wld, .prj) take the same name.

## Safe backup routine
At milestones, export a project file and copy it outside the browser; back up a folder
project as a whole, closed. Keep the quality report beside the final products.

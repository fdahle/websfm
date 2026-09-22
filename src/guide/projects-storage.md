---
id: projects-storage
title: Projects & Storage
summary: Understand autosave, browser storage, folder-backed projects, and portable .websfm files.
category: Start here
order: 2
---
websfm persists projects locally as you work; there is no upload or remote account.
The storage location matters because browser-private data and portable project files
have different backup behaviour.

## In this browser
The default uses the browser's Origin Private File System. It is fast and requires no
file management, but belongs to this browser profile and site origin. Clearing site
data, using a different browser, or changing the site URL can make it unavailable.
Create `.websfm` backups for work you cannot afford to lose.

## In a folder
On supported Chromium browsers, a new project can live in a normal folder. The folder
is the project: do not rename, move, or edit its internal files while it is open.
The browser may ask you to reconnect the folder after restart because access permission
is not always retained.

## Save project as .websfm
A `.websfm` file is a portable archive containing source images, features, matches,
reconstruction, and control. Including cached and derived data makes reopening faster
but can make the archive much larger. Excluding it is safe: previews, depth maps, DEM,
and orthophoto can be rebuilt.

The archive has a 4 GB ZIP limit. For a large project, exclude derived data or use a
folder-backed project as the working copy.

## Open and switch projects
Opening an archive imports it into local project storage; it does not work directly
inside the downloaded file. Let current writes finish before closing the tab. The
project picker switches between local projects without uploading anything.

## Safe backup routine
At important milestones, save a `.websfm` archive and copy it outside the browser.
For folder-backed work, back up the entire closed project folder as one unit. Keep an
exported quality report beside final products so the result and its diagnostics travel
together.

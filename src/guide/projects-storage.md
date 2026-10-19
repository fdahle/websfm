---
id: projects-storage
title: Projects & Storage
summary: Understand autosave, browser storage, folder-backed projects, and portable .websfm files.
category: Start here
order: 2
---
websfm persists projects locally as you work; there is no upload or remote account,
so projects open and save without a connection (see [Working Offline](guide:offline)).
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

**Move to folder…** in the project list copies a project from browser storage into a
folder you choose, checks the copy, and then removes the browser copy. **Move to
browser storage** copies it back and leaves the folder on disk untouched. Either way, an
open project is reopened from its new location, so everything it shows is read from
there.

## Save project as .websfm
A `.websfm` file is a portable archive containing source images, features, matches,
reconstruction, and control. Including cached and derived data makes reopening faster
but can make the archive much larger. Excluding it is safe: previews, image thumbnails,
depth maps, DEM, and orthophoto can be rebuilt. The octrees that big point clouds are
drawn from ([level of detail](help:level-of-detail)) are always included, and so is an
imported COPC file, which a cloud is read from in place.

A project file can be any size: past 4 GB it is written in the ZIP64 form, which
current archive tools (7-Zip, the Windows and macOS archive utilities, Python,
`unzip` 6) read as well. In browsers without a save dialog (Firefox, Safari) the
archive is built in memory before it is downloaded, so there a large project is better
saved without derived data, or kept as a folder-backed project. Opening a project
file needs as much free browser storage as the files it holds.

You can save while a step is running. The model, the matches and each DEM or
orthophoto go into the file as they were at one save, never half of one save and half
of the next: a save of one of them waits while the file takes its copy. Some files
are rewritten in place, such as a depth map during its filter pass. If one of those
changes after part of it is already in the file, the save stops and says so. Save
again when the step has finished.

## Open and switch projects
Opening an archive imports it into local project storage; it does not work directly
inside the downloaded file. Let current writes finish before closing the tab. The
project picker switches between local projects without uploading anything.

Opening a project reads the image list, each image's keypoint count and the match
graph's per-pair summary, not the features themselves. An image's keypoints and a
pair's matches are read from storage when something needs them: the keypoint overlay,
the match preview, a matching or reconstruction run, an export. The first overlay or
preview after opening can therefore take a moment. An image whose keypoint file is
missing shows an error status as soon as the project opens; detect it again.

## Safe backup routine
At important milestones, save a `.websfm` archive and copy it outside the browser.
For folder-backed work, back up the entire closed project folder as one unit. Keep an
exported quality report beside final products so the result and its diagnostics travel
together.

---
id: projects-storage
title: Projects & Storage
summary: Understand autosave, browser storage, folder-backed projects, storage running full, and portable .websfm project files.
category: Start here
order: 2
---
WebSfM persists projects locally as you work; there is no upload or remote account,
so projects open and save without a connection (see [Working Offline](guide:offline)).
The storage location matters because browser-private data and portable project files
have different backup behaviour.

Imported images are copied into the project. Once an image's copy is written, the
project reads the copy, so moving, renaming or deleting the original afterwards changes
nothing.

Where each project is kept shows in the project list, on the line under its name: a
folder icon and the folder's name, or *In this browser* with the size it takes there.
**Project settings ▸ Where it is saved** says the same, when the project was last
exported to a project file, and has the buttons to move it or to export it.

## In this browser
The default uses the browser's Origin Private File System. It is fast and requires no
file management, but belongs to this browser profile and site origin. Clearing site
data, using a different browser, or changing the site URL can make it unavailable.
Export a project file of work you cannot afford to lose.

The project list's foot says how much WebSfM holds in this browser. When the browser
has not agreed to keep that storage, it says so: such storage may be cleared when the
disk runs low on space. **Ask the browser to keep it** asks again; Chrome and Edge
decide by how the site is used (bookmarked, installed as an app, used often) and do
not show a question, Firefox asks. A coordinate system that had to be looked up on
epsg.io (one newer than the built-in catalog) is saved in the project too, so the
project opens offline in a browser that never looked it up.

## In a folder
On supported Chromium browsers, a new project can live in a normal folder. The folder
is the project: do not rename, move, or edit its internal files while it is open.
The browser may ask you to reconnect the folder after restart because access permission
is not always retained.

**Move to folder…** (in **Project settings**, or the project list's **⋯** menu) copies
a project from browser storage into a folder you choose, checks the copy, and then
removes the browser copy. **Move to browser storage** copies it back and leaves the
folder on disk untouched. Either way, an open project is reopened from its new
location, so everything it shows is read from there.

## When browser storage is full
Whatever finds browser storage full (adding images, a dense cloud, a mesh, a DEM, any
save; a private window allows little) asks at once to move the project to a folder on
your disk. Choose one, and what could not be saved is saved there, and a run in
progress continues there; the browser copy is removed and the project reopened once
nothing runs or waits to be saved. During a run, **Stop the run** ends it instead.

Say **Not now**, and the card at the lower left says how many changes are not saved,
with **Move to folder…** for later. Where folders are not possible (Firefox, Safari) it
says how to free space instead: delete another project, or clear the recomputable data
in **Project settings**, then **Retry saving**. **Dismiss** forgets the unsaved changes;
they stay in this session only, and are gone once the page closes or the project is
switched. It is also the way out of a save that can never succeed.

Nothing warns before an import: the browser's own estimate of its free space is not a
limit (Chrome raises it as the site writes), so a warning would come too early, and
storage runs full only when a write is refused.

## Export project file
**Other ▸ Export Project** (also in **Project settings** and the project list's **⋯**
menu) writes the whole project into one `.websfm` file: source images, features,
matches, the reconstruction, clouds and meshes, control, measurements and settings.
Only the console log stays behind. The project itself stays where it is and keeps
saving there; the file is a copy to keep or to open elsewhere.

**Include depth maps, DEMs, orthophotos and image previews** makes the file much
larger. Left out, image previews are made again when needed, but depth maps, DEMs and
orthophotos are not: they have to be built again. The octrees that big point clouds
are drawn from ([level of detail](help:level-of-detail)) are always included, and so
is an imported COPC file, which a cloud is read from in place.

A project file can be any size: past 4 GB it is written in the ZIP64 form, which
current archive tools (7-Zip, the Windows and macOS archive utilities, Python,
`unzip` 6) read as well. In browsers without a save dialog (Firefox, Safari) the
archive is built in memory before it is downloaded, so there a large project is better
saved without derived data, or kept as a folder-backed project; the export dialog
says so for a large one. Opened into this browser, a project file needs as much free
browser storage as the files it holds; opened into a folder, as much room on that disk.

You can save while a step is running. The model, the matches and each DEM or
orthophoto go into the file as they were at one save, never half of one save and half
of the next: a save of one of them waits while the file takes its copy. Some files
are rewritten in place, such as a depth map during its filter pass. If one of those
changes after part of it is already in the file, the save stops and says so. Save
again when the step has finished.

## Open and switch projects
A project file cannot be worked on in place, so opening one (**Open existing ▸ Project
file…**, or dropping it on the window) unpacks it into a new project. Where folders are
possible, it asks where: **In this browser**, or **In a folder…** on your disk, which it
is unpacked straight into, so a file larger than the browser allows still opens. Let
current writes finish before closing the tab. The project picker switches between local
projects without uploading anything.

Opening a project reads the image list, each image's keypoint count and the match
graph's per-pair summary, not the features themselves. An image's keypoints and a
pair's matches are read from storage when something needs them: the keypoint overlay,
the match preview, a matching or reconstruction run, an export. The first overlay or
preview after opening can therefore take a moment. An image whose keypoint file is
missing shows an error status as soon as the project opens; detect it again.

Each project records the format it was saved in. A project saved by an older version of
WebSfM is brought up to this version's format when you open it, in the place it is
saved, and the console says what changed (*Project upgraded: …*); after that, older
versions of WebSfM can no longer open it. A project saved by a newer version does not
open in an older one: reload the page to get the newest version.

## When the tab closes during a run
A browser can close a tab without warning: when the computer runs short of memory, for
an update, or when the tab is discarded in the background. Depth maps are saved one by
one as they finish, together with a note of how far the run got. When you open the
project again, WebSfM asks whether to **Continue** the stopped run or **Discard** it.
Continue computes only the depth maps that are missing, with the settings the run was
started with, and the result is the same as a run that was never stopped. It is offered
only while the sparse model, the images and those settings are unchanged; otherwise the
run starts again from the beginning. Cancel the question to be asked again the next time
the project opens.

## File name
Exports are downloads: the browser saves them in its downloads folder, or asks where
when it is set to. A point cloud or mesh export of more than about 256 MB asks where to
save it first in Chrome and Edge, and writes the file straight there when it is done;
Firefox and Safari download it. Each export dialog has an optional **File name**. Left empty, the
file is named after the project and what it holds (for example *Aukerman-ortho.tif*,
shown greyed in the field). A typed name replaces that for every file the export
writes: the extension is the format's, a world file (.wld) or projection file (.prj)
beside an image takes the same name, and an export of several rasters adds each one's
suffix (*site-slope.tif*, *site-hillshade.tif*). Characters a file name cannot hold
become `_`.

## Safe backup routine
At important milestones, export a project file and copy it outside the browser.
For folder-backed work, back up the entire closed project folder as one unit. Keep an
exported quality report beside final products so the result and its diagnostics travel
together.

---
id: command-console
title: Command Console
summary: Read the log, and type commands instead of clicking: every ribbon command, every processing step with its settings, the edits you make by hand, statistics and session tuning.
category: Start here
order: 6
---
The console at the bottom of the window shows the log and has a command line. It is open
when you first start WebSfM, and stays as you leave it. Open or close it with
**Other ▸ Console** or **Ctrl+`**; **Ctrl+K** (**⌘K** on a Mac) opens it and puts the
cursor in the prompt. **↑** and **↓** recall earlier commands, and **Tab** completes
a command, a setting name, a stage or a name (an image, a GCP, a product …); when
several fit, it completes as far as they agree and lists them.

## Reading the log
**Pipeline** is the record of what ran: the inputs and settings of each step, every
value chosen automatically with what it was chosen from, the result of each stage, and
one closing line when a step finishes (green), with its counts and time. Warnings
(amber) say what went on without you: a fallback, a photo left out, a value clamped.
Errors (red) say what failed and what to do. **Detail** adds the lines for a bug
report: one per image, pair or iteration, and timings inside a stage. **Activity**
lists the edits you made by hand (a GCP disabled, a product renamed); hover the **▸**
of a line to see the console command that does the same. The badge before a line is
its source, the part of WebSfM it comes from (Detection, Matching, Sparse, Dense,
Products …); **Filter** shows only some. **Save TXT** writes the Pipeline lines, with
Activity and Detail when you tick them.

## Ribbon commands
Every ribbon command is a console command, with the same prerequisites: a command
that is greyed in the ribbon is refused here with the same reason. Type its short
name (`detect`, `dense`, `decimate`, `contours`), its id (`crop-mesh`), or its id
as words (`crop mesh`, `export measurements`). The list is taken from the ribbon
itself, so a new button is a command as soon as it exists. **help** lists the
common ones by ribbon tab, **help tools** (or any tab) lists a tab, **help all**
lists everything, and **help** followed by a command shows its usage, where it is in
the ribbon and what it needs. The display steppers take a value:
`point size 4`, `camera size 1.4`.

## Run stages and workflows
`run detect match sparse` runs those stages in order through the
[workflow runner](guide:workflow-builder). An explicit run always runs: stages whose
output exists are run again. Every step a workflow can run unattended is a stage:
`detect`, `match`, `sparse`, `depth`, `dense`, `dem`, `ortho`, `mesh`, `texture`, and the
Tools edits `filter`, `normals`, `icp`, `clean`, `smooth` and `decimate`. A stage takes
its settings after it as `key=value`, the same settings the Workflow Builder shows:
`run dense minViews=3 mesh preset=high trim=strong`. A setting left out keeps its
default. **help run dense** lists a stage's settings, their values and defaults.

`run workflow Full pipeline` runs one of the project's saved workflows by name
(the start of the name is enough) with its own settings and policies. When it waits
(an interactive block, or "reuse existing output?"), the console says so: type
`continue`, `reuse` or `stop`. `stop` also cancels a running stage. A workflow whose
inputs are missing is refused with the reason, as Preflight shows it.

## Statistics
`stats` prints the project's counts: images and keypoints, matched and verified
pairs, the registered cameras and points of the sparse model, dense clouds, meshes,
the DEM and orthophoto, control points, saved measurements, and the frame the
numbers are in. `stats matches` describes the match graph: the inliers per pair,
the images with no verified pair, the weakest pairs and the pairs you excluded.

## Edits by hand
What you change by hand in the sidebar, the tables or a right-click menu can be typed
too, as `<what> <action> <names>`:

- `image enable|disable|rename`, `group create|rename|remove|add|ungroup`
- `sensor set <sensor> kind=film focalMm=153.2`, `sensor film`, `sensor assign`, `sensor new`
- `product main|rename|remove|show|hide`, and `product style "DEM 1" hillshade=true` for a
  DEM or orthophoto
- `layer rename|remove|show|hide` for vector layers
- `gcp add|set|role|enable|disable|remove`, `scalebar add|enable|disable|remove`
- `region set|clear`, `orientation clear`, `matches remove`, `template save`

`pair disable IMG_0012 IMG_0013` excludes a verified pair from reconstruction, as the
Matches list does, and `pair enable …` restores it; the change applies to the next
sparse reconstruction. `select IMG_0012` selects an image in the sidebar. A name need
only be long enough to be unique; put a name with spaces in quotes
(`gcp disable "GCP 12"`). **help edit** lists the edits with their arguments, and
**help gcp** (or any of them) one kind. Each edit appears in Activity as it does when
you click.

## Session tuning
`set` changes an internal tuning value that no dialog shows, for this session only:
`set sfm.minPnpInlierRatio 0.5` prints the old and new value and applies to the next
Sparse Model run. `sfm` holds the reconstruction knobs (`core/tuning.js` SFM_TUNING,
including the [bundle adjustment](help:bundle-adjustment) solver under
`sfm.baSolver.…`), `match` the matching ones. `set sfm` lists the keys and their
values, `set` alone lists what you changed, and `set sfm.minPnpInlierRatio default`
puts one back. The value must have the default's type (a number, true or false, or
text). A setting that a dialog shows is refused, with the dialog's name: set it there.
The run's log lists the overrides it used. They are not saved with the project and
are gone after a reload.

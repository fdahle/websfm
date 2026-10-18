---
id: command-console
title: Command Console
summary: Type commands instead of clicking: every ribbon command, plus running stages and workflows, project statistics, pair exclusion and session tuning.
category: Start here
order: 6
---
The console at the bottom of the window shows the log and has a command line. Open it
with **Other → Console**, **Ctrl+`**, or **Ctrl+K** (**⌘K** on a Mac), which also puts
the cursor in the prompt. **↑** and **↓** recall earlier commands, and **Tab** completes
a command, a setting name, a stage or an image name; when several fit, it completes
as far as they agree and lists them.

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
[workflow runner](guide:workflow-builder), with each stage's default settings. An
explicit run always runs: stages whose output exists are run again. The stages are
`detect`, `match`, `sparse`, `depth`, `dense`, `dem`, `ortho`, `mesh` and `texture`.
For other settings, use the dialog or a saved workflow.

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

## Exclude a pair
`pair disable IMG_0012 IMG_0013` excludes a verified pair from reconstruction, as the
Matches list does, and `pair enable …` restores it. Image names need only be long
enough to be unique; put a name with spaces in quotes. The change applies to the next
sparse reconstruction. `select IMG_0012` selects an image in the sidebar.

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

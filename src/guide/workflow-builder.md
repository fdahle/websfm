---
id: workflow-builder
title: Workflow Builder
summary: Assemble, configure, save, and run a sequence of reconstruction commands, with quality checks, branches and editable recipe text.
category: Start here
order: 3
---
Open **Reconstruct → Workflow Builder** to create a sequence of commands for the
current project. A new workflow starts with an empty canvas and a Blocks panel.
You can configure it before importing images; missing inputs appear under **Preflight**.

## Build and edit
Click a command in **Blocks** to append it. For a sparse model, add **Detect
Features**, **Match Features**, then **Sparse Model**. For a textured model, continue
with **Depth Maps**, **Dense Model**, **Build Mesh** and **Texture Mesh**; its **Decimate
to** setting reduces the mesh first (see [Texture a Mesh](guide:texture-mesh)). Select a block to edit its
settings in the inspector, which appears to the right or below the sequence on
smaller windows. **Guided**, **Standard**, and **Expert** control the settings detail.
The Match Features block's **Pairing** starts on **auto**: each run picks what the
Match Features dialog would open on for the project then (Preselect with camera
positions, Sequential for video frames, otherwise Exhaustive) and logs its choice, so
one workflow suits several kinds of project.

Drag blocks to reorder them, or use their **Move up** and **Move down** buttons.
Each block can be disabled, duplicated, or removed. **Recipe** shows the same
workflow as text, which you can copy or edit (see Recipe text below).

## Run a workflow
Import your images first. **Preflight** checks whether each enabled command has
the inputs it needs, including outputs from earlier blocks. Resolve dependency
problems before choosing **Run workflow**. You can also run a selected block or
start from it, provided the necessary inputs already exist.

A run with a block that reads image pixels (detection, depth maps, dense, orthophoto,
texturing, masks, fiducials) first checks that every image's file can still be read.
An image whose file was moved, renamed or deleted is restored from project storage
when the project has a copy; the rest are named in a warning before anything starts,
rather than failing an hour into the run. Re-add those files, or remove the images.

Automatic blocks execute in order. Interactive commands, such as Scale Bars or
Georeference, open their usual dialog and pause the workflow. Finish the command,
return to the builder, then choose **Mark complete & continue**. **Stop workflow**
requests cancellation of the current operation.

**Existing output** controls whether to reuse available results, ask, or rerun.
**Warnings** controls whether a warning pauses, continues, or stops execution.
Individual blocks can override these workflow defaults. Recent runs show their
outcomes in the Blocks panel, with the value each quality gate measured.

## Cleanup tool blocks
The Tools-tab edits that need no clicking in the 3D view are blocks too, so a
cleanup chain can be replayed on every new run:

- **Post-processing**: **Filter Point Cloud** (range, voxel, isolated clusters and
  [statistical outlier removal](help:statistical-outlier-removal), with the Light /
  Balanced / Strong presets), **Estimate Normals** and **Align to Reference (ICP)**.
- **Mesh tools**: **Clean Mesh**, **Smooth Mesh** and **Decimate Mesh**.

Each tool block works on what the previous block of the same run made: the first
one on the cloud Dense Model built (or, without one, the newest dense cloud), the
next on that result, and so on; mesh tools start from Build Mesh's mesh. **Build
Mesh** meshes the chain's cleaned cloud when it still has normals, and **Texture
Mesh** textures the chain's cleaned mesh. Every block adds a new cloud or mesh and
leaves its source untouched, so these blocks always run, and running the workflow
again adds new copies. Decimate Mesh keeps a mesh that is already below its target.

**Align to Reference (ICP)** needs the exact name of the reference cloud or mesh, as
shown in the Data panel, because a replayed workflow cannot ask you to pick it. It
only refines: the clouds must already roughly overlap (see [ICP](help:icp)). Crop
and Merge stay interactive blocks, since their box and sources are chosen per project.

## Quality gates and branching
A **Quality Gate** block (under **Control**) measures one of the numbers the
[Quality Report](guide:quality-report) records and compares it with a threshold.
When it passes, the run continues; when it fails, it can pause, stop, carry on, or
jump to another block. A **Go to** block jumps unconditionally, which lets two
branches meet again or end early.

Jumps always go *down* the list, to a block below the gate or to the end. Every
stage is deterministic, so running the same blocks again with the same settings
would measure the same value; a retry is written as a branch to a copy of the stage
with other settings. For example: Sparse Model, a gate on the reprojection median
that goes to a second Sparse Model with the High preset when it fails and otherwise
jumps past it to Depth Maps.

Preflight checks every gate: the metric must be measurable where the gate sits
(Depth-map coverage needs Depth Maps on every path that reaches the gate), the
threshold set, and every jump must name an existing block below. A block that no
path reaches is flagged. A gate whose metric the project cannot report when it runs,
such as a GCP error without GCPs, counts as failed.

Each run records every gate it passed through, with the measured value, the outcome
and where the run went; blocks a jump passed over show as **skipped**.

## Name
<!-- param: name default: none -->
An optional short name for the block, made of letters, digits, `-` and `_`. Jumps
refer to blocks by name, so pointing a gate or Go to block at an unnamed block names
it for you (for example `reconstruct-1`). Renaming a block updates the jumps that
point at it; names must be unique, and `end` is reserved for the end of the workflow.

## Metric
<!-- param: metric default: Registered images -->
What the gate measures. Each metric needs a result from an earlier block:

- **Registered images** (%), **Reprojection median** (px, the median
  [reprojection error](help:reprojection-error)), **≥3-view tracks** (% of
  [tracks](help:track) seen by three or more images), **Sparse points**,
  **Self-cal warp fit RMS**, **Focal Δ vs nominal** (compared as an absolute value),
  **GCP RMSE** and **Pose RMSE**: after Sparse Model.
- **Match-graph components**: after Match Features.
- **Depth-map coverage** (mean % of each [depth map](help:depth-map) with a valid
  depth): after Depth Maps.
- **Dense points**: after Dense Model; after a cleanup tool block, the point count
  of that block's result.
- **DEM ΔZ RMSE**: after Build DEM, with GCPs.

Changing the metric resets **Passes when** and **Threshold** to its defaults.

## Passes when
<!-- param: op default: the metric's own -->
The comparison the measured value must meet: at least (`>=`), more than (`>`), at
most (`<=`) or less than (`<`) the threshold. Each metric starts with the direction
that means good: at least for shares and counts, less than for errors.

## Threshold
<!-- param: threshold default: the Quality Report's warning level -->
The value to compare with, in the metric's unit. Each metric starts at the level
where the Quality Report starts to warn (90 % registered, 1 px reprojection median,
50 % depth-map coverage, …), so a default gate passes exactly when the report shows
that row without a warning. Tighten it for demanding work, loosen it for difficult
imagery.

## If it fails
<!-- param: onFail default: Pause and ask -->
- **Pause and ask** shows the measured value and waits for **Continue** or **Stop**.
- **Stop the workflow** ends the run, recorded as failed with the gate's reason.
- **Continue (record only)** keeps going; the run still records the failure.
- **Go to a block** jumps to **On fail, go to**.

## On fail, go to
<!-- param: failTarget default: none -->
Where a failed gate continues when **If it fails** is *Go to a block*: a block below
the gate, or **End of workflow** (the run then ends as completed).

## On pass, go to
<!-- param: passTarget default: Next block -->
Where a passing gate continues. **Next block** simply carries on; choose a block
below to skip a fallback branch that only a failure should run.

## Go to
<!-- param: target default: none -->
The block below where the run continues, or **End of workflow**. Use it at the end
of one branch to jump over the other, so the two meet again at a later block.

## Recipe text
**Recipe** shows the workflow as text, one block per line, top to bottom. Edit it
and choose **Apply recipe** to rebuild the blocks; **Revert** discards the edit.
The text and the blocks are the same workflow: applying the recipe of an unchanged
workflow gives back exactly the same blocks and settings.

```
workflow "Survey with checks"
defaults warning=pause reuse=valid display=standard
reconstruct preset="medium"
gate metric="reprojMedianPx" op="<" threshold=1 onFail="branch" failTarget="hq" passTarget="depth"
hq: reconstruct @reuse=rerun preset="high"
depth: compute-depth quality="medium"
filter-cloud @off preset="light"
```

- A line starts with an optional `name:`, then the block's id, then settings as
  `key=value`. Values are JSON: text in double quotes, lists in brackets such as
  `methods=["voxel", "sor"]`, numbers, `true`, `false` and `null`. A single word that
  is not JSON, like `preset=high`, is read as text.
- `@off` disables a block; `@reuse=valid|ask|rerun` and
  `@warning=pause|continue|stop` override the workflow defaults for that block.
- Settings you leave out keep their defaults. `#` starts a comment, except inside
  quotes.
- `workflow` and `defaults` are optional and come before the first block.

Apply refuses a recipe it cannot read exactly and lists each problem with its line
number: an unknown block or setting, a value of the wrong type or outside a list's
choices, a setting given twice, or a jump to a name no block has. Nothing is
applied until every line reads.

## Save and reuse
Workflow edits are saved with the project. Use **New** for another empty workflow,
**Duplicate** for an independent copy, and **Switch workflow** to change the active
one. **Save template** stores a reusable copy in this browser. Clicking its name
under **My templates** creates a new project workflow from that copy.

Image import and result export remain separate commands in the main interface.

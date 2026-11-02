---
id: workflow-builder
title: Workflow Builder
summary: Assemble, configure, save, and run a sequence of reconstruction commands, with quality checks, branches and editable recipe text.
category: Start here
order: 3
---
Open **Reconstruct ▸ Workflow Builder** to build a sequence of commands for the
project, save it and run it again. You can set it up before importing images; missing
inputs show under **Preflight**.

## Build and edit
Click a command in **Blocks** to add it: Detect Features, Match Features and Sparse
Model for a sparse model, then Depth Maps, Dense Model, Build Mesh and Texture Mesh for
a textured model. Select a block to edit its settings; **Guided**, **Standard** and
**Expert** set how many show. Match Features' **Pairing** starts on **auto**, choosing
per project as its dialog would. Drag blocks to reorder; each can be disabled,
duplicated or removed. **Recipe** shows the workflow as editable text.

## Run a workflow
**Preflight** checks that each block has its inputs, including those earlier blocks
make. **Run workflow** runs them in order; you can also run one block or start from it.
Missing image files are reported before the run starts. Interactive commands (Scale
Bars, Georeference) open their dialog and pause; finish them, then **Mark complete &
continue**. **Existing output** decides whether results are reused, asked about or
rebuilt, and **Warnings** whether a warning pauses, continues or stops; each block can
override both.

## Cleanup tool blocks
The Tools edits that need no clicking are blocks too: **Filter Point Cloud**
([statistical outlier removal](help:statistical-outlier-removal) and more),
**Estimate Normals**, **Align to Reference (ICP)**, **Clean Mesh**, **Smooth Mesh** and
**Decimate Mesh**. Each works on the previous block's result, and Build Mesh and
Texture Mesh use the cleaned cloud and mesh. ICP needs the reference's exact name, and
the clouds must already roughly overlap ([ICP](help:icp)). Crop and Merge stay
interactive.

## Quality gates and branching
A **Quality Gate** (under **Control**) measures one of the
[Quality Report](guide:quality-report)'s numbers against a threshold. On failure it can
pause, stop, carry on or jump to another block; a **Go to** block jumps always. Jumps
only go down the list. A retry is a branch to a copy of the stage with other settings,
for example a second Sparse Model with the High preset when the reprojection error is
too high. Preflight checks that every gate can be measured where it sits and every jump
has a target; each run records the gates it passed and the values measured.

## Name
<!-- param: name default: none -->
An optional unique name (letters, digits, `-`, `_`) that jumps refer to. Pointing a
jump at an unnamed block names it; renaming updates the jumps. `end` is reserved.

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
- **Dense points**: after Dense Model or a cleanup block.
- **DEM ΔZ RMSE**: after Build DEM, with GCPs.

## Passes when
<!-- param: op default: the metric's own -->
How the measured value must compare with the threshold (`>=`, `>`, `<=`, `<`). Each
metric starts with the direction that means good.

## Threshold
<!-- param: threshold default: the Quality Report's warning level -->
The value to compare with, in the metric's unit. It starts where the Quality Report
starts to warn, so a default gate passes when the report shows no warning. Tighten it
for demanding work, loosen it for difficult images.

## If it fails
<!-- param: onFail default: Pause and ask -->
- **Pause and ask** shows the measured value and waits for **Continue** or **Stop**.
- **Stop the workflow** ends the run, recorded as failed with the gate's reason.
- **Continue (record only)** keeps going; the run still records the failure.
- **Go to a block** jumps to **On fail, go to**.

## On fail, go to
<!-- param: failTarget default: none -->
Where a failed gate goes with *Go to a block*: a block below, or **End of workflow**.

## On pass, go to
<!-- param: passTarget default: Next block -->
Where a passing gate goes: **Next block**, or a block below to skip a fallback branch.

## Go to
<!-- param: target default: none -->
The block below where the run continues, or **End of workflow**: use it to end one
branch so two branches meet again.

## Recipe text
**Recipe** shows the workflow as text, one block per line. Edit it and **Apply
recipe** to rebuild the blocks; **Revert** discards the edit.

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

A recipe with any error (unknown block or setting, wrong value, missing jump target)
is refused with each problem and its line; nothing is applied until all lines read.

## Save and reuse
Workflows are saved with the project. **New**, **Duplicate** and **Switch workflow**
manage several; **Save template** keeps a copy in this browser for other projects
(**My templates**). Importing images and exporting results stay separate commands.

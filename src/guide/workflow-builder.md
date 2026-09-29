---
id: workflow-builder
title: Workflow Builder
summary: Assemble, configure, save, and run a sequence of reconstruction commands.
category: Start here
order: 3
---
Open **Reconstruct → Workflow Builder** to create a sequence of commands for the
current project. A new workflow starts with an empty canvas and a Blocks panel.
You can configure it before importing images; missing inputs appear under **Preflight**.

## Build and edit
Click a command in **Blocks** to append it. For a sparse model, add **Detect
Features**, **Match Features**, then **Sparse Model**. Select a block to edit its
settings in the inspector, which appears to the right or below the sequence on
smaller windows. **Guided**, **Standard**, and **Expert** control the settings detail.

Drag blocks to reorder them, or use their **Move up** and **Move down** buttons.
Each block can be disabled, duplicated, or removed. **Recipe** shows a read-only
text version that you can copy.

## Run a workflow
Import your images first. **Preflight** checks whether each enabled command has
the inputs it needs, including outputs from earlier blocks. Resolve dependency
problems before choosing **Run workflow**. You can also run a selected block or
start from it, provided the necessary inputs already exist.

Automatic blocks execute in order. Interactive commands, such as Scale Bars or
Georeference, open their usual dialog and pause the workflow. Finish the command,
return to the builder, then choose **Mark complete & continue**. **Stop workflow**
requests cancellation of the current operation.

**Existing output** controls whether to reuse available results, ask, or rerun.
**Warnings** controls whether a warning pauses, continues, or stops execution.
Individual blocks can override these workflow defaults. Recent runs show their
outcomes in the Blocks panel.

## Save and reuse
Workflow edits are saved with the project. Use **New** for another empty workflow,
**Duplicate** for an independent copy, and **Switch workflow** to change the active
one. **Save template** stores a reusable copy in this browser. Clicking its name
under **My templates** creates a new project workflow from that copy.

Image import and result export remain separate commands in the main interface.

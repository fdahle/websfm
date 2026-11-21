# Conventions

The rules a change to WebSfM follows, by what it touches.
[CONTRIBUTING.md](../CONTRIBUTING.md) says how to set up and what a pull request needs;
this page is the detail it points to. You don't need to read it all: read the section
for the kind of change you are making. Most of these rules are checked by
`npm run check`, so a failing test usually names the rule it holds you to.

## Keep the in-app help in step

The app explains itself in two places:

- `src/glossary/**/*.md`: concepts (SIFT, RANSAC, depth map …). Each entry has
  frontmatter `id/title/summary/aliases`; aliases auto-link wherever help text
  mentions them.
- `src/guide/*.md`: one article per operation, with a `## ` section per setting
  bound by `<!-- param: key  default: … -->`.

Write both for the people who use WebSfM: they know photogrammetry, often from
Metashape, COLMAP or ODM, and want to know what a setting does and when to change it,
not how it was tuned. A setting's guide section is a few sentences, about 80 words at
most, because its hover box shows it whole: what it does, when to raise or lower it,
what it costs. An article's introduction says what the operation makes and when to run
it. Leave out the names of test datasets, bench numbers, dates and the history of a
change: the evidence belongs in the CHANGELOG entry, the algorithm in
[docs/METHODS.md](METHODS.md). Call things by the names in
[docs/terms.md](terms.md) (*dense cloud*, *checkpoint*, *keypoint* …), so a thing has
one name wherever a user meets it.

Whenever a change alters what a setting or operation does, changes a default, or
adds, removes or renames a setting, operation or user-visible feature:

1. Update the matching guide section and its `default:` marker, and any glossary
   entry whose text describes the old behaviour. (The unit tests check that every
   help link resolves, and `guideDefaults.test.js` that a `default:` marker names the
   value its `FieldHelp` field starts from: the number, On/Off, or the option's id or
   label. A default that depends on the project ("Auto: … when …") is still yours to
   check.)
2. A setting that has a guide section gets its label wrapped as
   `<FieldHelp op="…" param="…" :value="settings.x" :default-value="X_DEFAULTS.x">Label</FieldHelp>`.
   Pass the `*_DEFAULTS` constant, and leave both values out for selects.
   - Keep one hover target per label: don't add a `GlossaryTerm` inside or beside a
     `FieldHelp`. Make the guide text link the concept instead (auto-link or
     `[text](help:id)`), so it opens as a nested box.
   - Labels without a guide section may use `<GlossaryTerm id="…">`, pointing at the
     entry that explains that exact concept.
   - The two look different on purpose: a `FieldHelp` label gets a small **?** after
     it (advice on this setting), a `GlossaryTerm` a **dotted underline** (what a word
     means), as `help:` links in help text do. Don't restyle one like the other. A
     setting in a dialog whose operation has a guide article gets a guide section and
     a `FieldHelp`, not a `GlossaryTerm`.
3. A new concept gets a new glossary entry. Keep aliases specific: a generic alias
   such as "projection" or "3D point" links in the wrong places.
4. A keyboard shortcut or modifier gesture is an entry in `src/core/help/shortcuts.js`.
   The handler tests `matches(e, 'group.name')`, never `e.key` directly, and a tooltip
   names the key with `keyLabel('group.name')` instead of typing "(Ctrl+Z)". The
   Shortcuts dialog lists the table, and a unit test fails on an entry no handler
   matches. Plain control behaviour (Enter or Esc in a field, arrows in a menu) is not
   a shortcut.
5. Code that implements a published method cites it: add the paper to
   `src/core/help/references.js` (key, authors, year, title, venue, DOI), list its key
   under `refs:` in the glossary entry that explains the method, add it to
   `src/core/help/methodsUsed.js` when it is a pipeline step the Quality Report should
   name, and add the same line to the References section of
   [docs/METHODS.md](METHODS.md). The unit tests fail on a key that does not
   resolve, an entry nothing cites, or one missing from METHODS.md.
6. An internal tuning value (`src/core/tuning.js`) is help too: Debug ▸ Flags shows the
   first paragraph of the comment above it, up to the comment's first empty `//` line.
   Write that paragraph as a setting's guide section, shorter (one to three sentences:
   what it does, which way to move it, what that costs), and put the evidence after the
   empty line: the measurements, the sets they were made on, dates, plan items and the
   code that reads the value, which stay in the code. A section title (`// ── … ──`) is
   in the user's words too. `tuningHelp.test.js` fails on shown help with a date, a test
   set's name, a before/after number, a plan or note reference or a file name.

## Third-party code and data

Every build ships `THIRD_PARTY_NOTICES.txt` and About ▸ Licenses, made by
`scripts/licenses/` ([THIRD_PARTY.md](../THIRD_PARTY.md) says what is in them):

- **An npm package or a Rust crate** needs nothing by hand: the build lists the packages
  it bundles, and `npm run build:wasm` the crates in the WebAssembly modules
  (`src/wasm/third-party.json`; CI checks it against `Cargo.lock`). When one publishes no
  license text, the build warns: put the upstream text in `licenses/packages/<name>/` or
  `licenses/crates/<name>/`.
- **Code, a table, a model or data taken in by hand** (ported code, a code table, model
  weights, a dataset) gets an entry in `src/core/help/licenses.js`, its license text under
  `licenses/`, a line in [THIRD_PARTY.md](../THIRD_PARTY.md), and a comment at the top of the
  file that holds it naming where it came from. A unit test fails on an entry without its
  text, or a downloadable model without an entry.
- A test fixture or screenshot uses data you may share: the example project (CC0) or
  your own. Check the license of anything else first.

## Disabled controls say why

A greyed-out control says on hover what it is missing or what to do, in the user's
terms: "Build a DEM first (Reconstruct ▸ DEM)", "Needs three GCPs marked in two aligned
photos each", "Wait for the run to finish". Put the reason in the disabled element's own
`title` (a disabled control may not pass hover on to its label), reuse the reason a
`WarnBox` or an effect's `blocked` line already gives rather than wording it twice, and
give a disabled `ChoiceCards` option its `reason`. The ribbon does the same through
`commandReason`. A unit test (`src/components/disabledReasons.test.js`) fails on a
disabled control without a `title`.

## Text in the UI

WebSfM is being prepared for more languages, German first. The words a user reads live
in catalogues, not in the code, so a translation is a new catalogue rather than a
change to every component:

- **Catalogues:** `src/core/i18n/en/<area>.js`, one per area, in ICU MessageFormat:
  `{n, number}` formats a number in the user's language, `{n, plural, one {# point}
  other {# points}}` picks the form. A key is `<area>.<path>` (`filterCloud.step.sor`).
- **In a template:** `{{ t('filterCloud.run') }}`, `:title="t('…')"`, from
  `composables/useI18n.js`. A message with a bold menu path is `<I18nText k="…" />`,
  with `<strong>…</strong>` in its catalogue text.
- **From `src/core/` and the workers:** return a message, `msg('area.key', params)`
  (from `core/i18n/msg.js`, which carries no catalogues),
  never a finished sentence; the UI shows it with `tx(m)`, and `SettingsStep`,
  `PresetCards` and `SourcePicker` take one as it is. A parameter may be a number,
  another message, or an array of messages (shown as a list: "a and b").
- **Numbers on screen** are message parameters, so they get the language's decimal sign.
  Numbers written to files stay `toFixed`, which always writes a dot.
- **The ribbon** stays worded in its tables (`core/help/ribbonTabs.js`, the reasons in
  `commands.js`); `core/help/ribbonText.js` gives each text its key
  (`ribbon.cmd.<id>.label`, `ribbon.group.<name>` …) and another language words them in
  `<lang>/ribbon.js`. A reused entry that changes its label gives it a `labelId`. A menu
  path in a message (`Reconstruct ▸ Dense Model`) must name the ribbon as that language
  words it; a unit test checks.
- **A link or button inside a sentence** is a tag the component draws through a slot,
  `Import as <first>{first}</first>` with `<template #first="{ text }">`, so each
  language keeps its own word order.
- **Languages:** `src/core/i18n/<lang>/` holds a language's catalogue; a key it lacks
  shows in English. A `preview` language (German, for now) is never picked from the
  browser's language, only by hand (Settings ▸ General ▸ Language, which lists it as
  partly translated, or `lang de` in the command line), until it covers the app.
  `PLANNED_LANGUAGES` (`core/i18n/index.js`) are the languages to come: Settings lists
  them greyed out; one moves into `LANGUAGES` with its first catalogue. Add the German for the keys you add when you can. German keeps a technical
  term in English where people in the field say it in English (Outlier, Preset, GCP,
  GSD, Mesh, DEM, Cluster); everyday words and the sentences around them are German
  (*Abbrechen*, *Punktwolke*, *Ausgabe*).
- **Logs, console commands and bug reports stay in English.**
- **Tests check the English:** render with `renderAll(…)` before comparing. The unit tests
  fail on a key the code names that the English catalogue lacks, a message that does not
  parse, another language's message with different arguments, and a short fact over
  `SHORT_MAX` in any language.
- **Every component is checked**, but those listed in `src/components/i18nPending.js`:
  bare English in a template fails the lint (`vue/no-bare-strings-in-template`), and
  English in template expressions or the script fails `src/components/bareText.test.js`.
  A new component is written this way from the start and never goes on the list. The
  list only shrinks: when you are changing a listed component anyway, convert it and
  take it off.

## Menu labels

A menu item or a small button ends in **…** when it needs more from you before it acts:
a dialog with settings, a file or folder picker (*Symbology…*, *Download…*, *Move to
folder…*). One that acts at once, or only asks "are you sure?", has none (*Rename*,
*Delete*, *Remove*).

## An option or not

A change that makes a step faster or better either becomes a setting or doesn't:

- **A pure win is not an option.** When the change is better or equal on every project
  measured, at no real cost in time or memory, it simply replaces the old behaviour.
  "Every project measured" means at least the regression gate's (`scripts/bench/gate.json`:
  close range outdoors and indoors, a drone block, film scans), not the kind of project the
  change was made for. A gain shown only on synthetic data is a hypothesis: it ships when a
  real project gains and the gate holds. (0.8's best-first RANSAC sampling was measured on
  aerial and film blocks only and cost close-range scenes up to half their cameras.)
- **A trade-off is an option.** When it costs something a user may care about (time,
  memory, completeness against accuracy) or helps one kind of project and hurts another,
  it gets a setting, with the default that suits most projects. An Auto default may
  decide by what it can see (GPU or not, aerial or object), and its effect line says what
  it chose.
- **Trade-offs that only make sense together are one setting**, a preset such as Depth
  Maps ▸ Method (Full or Fast), not a checkbox per part.

Say in the CHANGELOG entry what the measurement was, so the next person can tell which
case it is.

## Every dialog's frame

Every dialog is a `ModalShell` (`components/modals/ui/ModalShell.vue`), and its title bar
is the shell's alone, so all dialogs look alike:

- the title is the shell's `title` (an Experimental badge in `#badge`), never markup of
  the dialog's own; a count or the CRS a table is in goes in `subtitle`, the dim line
  under it;
- header controls (the presets menu, a refresh button, a List/Graph toggle) go in
  `#actions`, beside the close button; tabs go in `#tabs`, as
  `<button class="modal-tab" :class="{ active }">`, in a row under the header;
- a choice of a few options is a `SegmentedControl`, a select `field-select`, the
  buttons in `#footer`.

A unit test (`src/components/modals/ui/modalShellSlots.test.js`) fails on a slot the shell does not have.

## Dialogs of a processing step

A dialog that runs a processing step lays out its settings as numbered steps, in the
order the run applies them. That covers every Reconstruct dialog (Detect and Match
Features, Sparse Model, Depth Maps, Dense Cloud, DEM, Orthophoto, Mesh), every Tools
dialog that takes settings and has a Run button (Filter, Crop, Clean mesh, Texture,
Contours, Optimize cameras, Detect fiducials, Auto mask …), and any new one. A dialog built around a
live preview, a result table or a readout (Reseau, Section, Mesh area &
volume) is a workbench: it uses the same fields but no numbered steps.

1. Each stage is a `<SettingsStep step="n" title="…" :effect="…">`, listed **once**, in
   run order, as a group: its header (number, title, short fact) opens and closes it.
   Its everyday fields (a mode, a resolution, a stage's on/off switch) are its content;
   the fields whose defaults suit almost every project go in its `#tuning` slot.
   Presets, the source and mode choices may sit above the steps.
2. The dialog calls `provideStepLayout('<dialog id>')` (`composables/useStepLayout.js`)
   and puts `<ShowAdvancedSettings />` first in its footer. An open step shows its long
   effect, its everyday fields and, while **Show advanced settings** is on, its
   `#tuning` fields under an *Advanced* divider (with it off, a gray note says how many
   are hidden, counted as they render; a note, not a link). A closed step shows none of
   them. Steps with everyday fields start open; a step the user opens or closes stays
   so in that dialog (in this browser).
3. Each step's **effect** comes in two lengths, from the same rules the run applies:
   the long line an open step shows ("42 depth maps at up to 1,500 px …", "Off: lone
   points stay in the cloud") and the short fact its header shows ("1,500 px · 10
   views", "off"; at most `SHORT_MAX`, 40 characters, no sentence). Write them as pure
   functions in `src/core/stepEffects/<dialog>.js` (`…Effects` and `…Shorts`, paired
   by `withShorts`), with unit tests, and pass the project data into the dialog as
   props.
4. A step that cannot matter in the current configuration is `inactive`: its fact is
   dimmed (its fields stay as usable as any other), and its long effect says why.
5. The guide article lists its setting sections in the same order as the steps. A
   dialog with only a few settings (about five) and no tuning needs no layout: its
   steps simply hold their fields and effects.
6. **Quality cards:** where a dialog has a real quality-against-time ladder (resolution,
   density, the mosaic method), cards at the top set it (Fast · Balanced · Detailed, or
   the dialog's own words); the card names say what they change, and the CHANGELOG
   gives the measurement behind them.
7. **Fields:** what the source is (cloud, mesh, model) sits above the steps as a
   *Source* group. A select is `class="field-select"`: it is as wide as its longest
   option, not the dialog, like a number field is as wide as its number. A free-text
   field (a file name) is `field-input wide`.

Adding or moving a setting means updating its step's effect and its test too.

## The console

The console is two things: the **log**, the record a user reads back, exports and
attaches to a bug report, and the **command line**, which reaches everything the
mouse does. A new step, tool or edit is not done until both are right. The table of
sources, levels and channels is `src/core/logRules.js`; `src/core/logRules.test.js`
checks every log line in `src/` against the rules below.

### What a line is

A line is `log(message, level, source, opts)` (`composables/useLog.js`), or
`onLog(message, level, source)` from `src/core/` and a worker's
`emit('log', [message, level, source])`.

- **Source**: the area a user would look under for the line, one of `LOG_SOURCES` in
  `core/logRules.js`, named as the ribbon names that area: Project, Import, Images,
  Sensors, Fiducials, Poses, Detection, Matching, Sparse, Georeferencing, Dense,
  Products, Evaluate, Export, Workflow, Models, System, Viewer, Console. Each entry says
  what it covers. A line about one product takes its kind's source
  (`productLogSource(kind)`). A new area is a new entry there, not a new word at the
  call. Code outside `src/core/` and the workers always names the source; core code
  may leave it out when one function serves several areas, and the code that runs it
  relays with a default: `onLog: (m, l, c) => log(m, l, c ?? 'Dense')`. A relay keeps
  the level it is given (never `(m) => log(m, 'info', …)`).
- **Level**: what the user should do with the line.
  - `debug` (shown with **Detail**, left out of the export unless asked): what a bug
    report needs and a user does not: a line per image, pair, tile, slab or iteration,
    timings inside a stage, memory marks, a cancelled item.
  - `info`: the record: what ran on what, the settings, each value chosen automatically
    with its inputs, a stage's result, a step the user cancelled ("Building DEM
    cancelled").
  - `success`: the **one** closing line of an operation the user started that finished,
    with its result, counts and time ("Dense cloud "Dense cloud 2": 41,233,118 points
    from 212 depth maps in 312.4 s"). It is written by the store or composable that
    started the operation and kept its result, never by `src/core/` or a worker (they
    report at `info`); nor by a hand edit or a project's restore.
  - `warn`: the operation went on, but the user should know: a fallback (GPU → CPU), an
    input left out and why, a value clamped, a result that looks weak, a step declined
    (a model not downloaded).
  - `error`: the operation, or a part the user asked for, failed: what failed, why, and
    what to do about it, in the user's terms.
- **Channel**: `pipeline` (the default) is the record. `activity` confirms an edit the
  user made by hand (rename, enable, set as main, remove, restyle), at `info`, and names
  the console command that makes the same edit: `{ channel: 'activity', command:
  editCommand('gcp disable', [g.name]) }` (`core/help/consoleEdits.js`). The console
  shows it on hover; the test fails on an Activity line without a command that
  resolves.

### What an operation logs

A processing step, an import or an export writes, in this order:

1. what it runs on and with which settings (`info`): the input counts and the settings
   that decide the result;
2. every value it chose by itself, with what it chose it from, so a run can be
   reproduced from its log ("GSD 0.042 m: median ground sample of 212 photos");
3. how it spread the work: the number of workers or threads, the GPU or CPU path
   (`info`, a fallback at `warn`);
4. each stage's result in a multi-stage run (`info`); the per-item detail at `debug`;
5. what it left out or clamped (`warn`), with a count and the reason;
6. one closing line: `success` with the result, its counts and the wall time; or
   `info` "… cancelled" and what was kept; or `error` with what to do.

A run that logs one line per item at `info` floods the record of a 1,000-photo
project: count them and log the count, put the items at `debug`. Progress belongs in
the progress bar, not the log; a long stage may log a paced heartbeat
(`createLogPacer`, `utils/blockProgress.js`).

### How a line reads

- English, as the logs stay ([Text in the UI](#text-in-the-ui)), in the words of
  [docs/terms.md](terms.md). Numbers in English too: `n.toLocaleString('en')`,
  never a bare `toLocaleString()`, which writes "1.234" in a German browser.
- It starts with a capital letter, or with a name ("${img.name}: …", "transforms.json …").
- It does not repeat its source ("Dense: …" under Dense): the badge shows it. A sub-step
  may lead ("Fusion: …" under Dense, "Mesh: …" under Products), and what follows the
  colon is lower case.
- A failure reads "<what> failed: <why>" ("Saving the matches failed: …"), never a bare
  `err.message`, "X error:" or "Error:"; add what to do when you know it.
- A line a user sees by default (not `debug`) has no shorthand: bundle adjustment, not
  BA; calibration, not intrinsics; observations, not obs; project storage, not OPFS;
  no "Stage A", "init", "kp", "NCC", and no capitals for emphasis ("REJECTED"). Name a
  setting by its label in the dialog ("Max matching cost", not `maxCost`) and a step by
  its command ("run Sparse Model again", not "re-run reconstruction").
- Units on every number (px, m, s, MB), a name in quotes when it is a user's name.

### Everything can be typed

Whatever the mouse can do, the command line can, so a user can script it, and a bug
report can say exactly what was done:

1. **A ribbon command** is a console command by itself (`core/help/commands.js`
   reads the ribbon tables). Give a common one a short name in `CONSOLE_NAMES`.
2. **A processing step** that a workflow can run unattended is a `run` stage with its
   settings as `key=value` (`core/help/consoleRun.js` reads `WORKFLOW_BLOCKS`). A new
   step gets an automated workflow block; give it a short word in `STAGE_WORDS`.
3. **An edit made by hand** (sidebar, table, right-click) is an Edit command,
   `<noun> <action> <arguments>`, in `EDITS` (`core/help/consoleEdits.js`), carried out
   in `composables/useConsoleEnv.js` by the same store call the click makes. Its
   Activity line names it (above).
4. A console-only command with arguments is a verb in `VERBS` (`commands.js`) with its
   handler in `core/help/console.js`.

The command line stays in English and is checked by `console.test.js` against a fake
environment; the help article is `src/guide/command-console.md`.

// Pure command registry for the DevConsole command line (power-user front end).
//
// A text front end over the SAME command dispatch the ribbon uses (`handleCommand(id)`
// in App.vue). The command list is DERIVED from the ribbon tables (ribbonTabs.js
// `ribbonEntries`): every ribbon command is typeable by its id ("crop-mesh"), its id
// as words ("crop mesh") and, for the common ones, a short name from CONSOLE_NAMES
// below ("decimate"). A new ribbon button is a console command the moment it exists;
// only its short name is hand-made. Help text is the ribbon's own location and blurb,
// so the two front ends cannot drift.
//
// Console-only VERBS (run, stats, set, pair, select …) take arguments; they are
// executed by core/help/console.js against an injected environment. No Vue / Pinia /
// DOM here — plain data in, plain data out — so it stays unit-testable ("core is
// pure", CLAUDE.md). The impure binding lives in composables/useCommands.js and
// composables/useConsoleEnv.js.
//
// Guard parity: a console command that dispatches a ribbon command takes that
// command's prerequisites (`needs`, `aerialOnly`, `disabled`) straight from the
// ribbon table (`consoleReason`), so the two front ends cannot drift — copies of
// the needs here once did. Only console-only verbs carry their own `needs`.

import { allGroups, leafCommands, ribbonEntries, labelText } from './ribbonTabs.js'

// Prerequisite checks: the ONE table behind both gates, the ribbon's greyed
// buttons/menu rows (Ribbon.vue `needs: [...]`) and this command line, so the two
// can never disagree. Each: does `state` (App.vue `commandState`) satisfy it, and
// why not. A missing state field reads as unmet.
export const NEED_CHECKS = {
  project: { ok: (s) => !!s.projectReady, reason: 'Open a project first' },
  images: { ok: (s) => s.imageCount > 0, reason: 'Import images first' },
  imagesReady: { ok: (s) => !s.imagesLoading, reason: 'Images still loading…' },
  keypoints: { ok: (s) => s.kpImageCount > 0, reason: 'Detect keypoints first' },
  matches: { ok: (s) => s.matchCount > 0, reason: 'Run feature matching first' },
  sparse: { ok: (s) => s.sparseReady, reason: 'Build the sparse model first' },
  depthMaps: { ok: (s) => s.depthMapCount > 0, reason: 'Compute depth maps first' },
  cloud: { ok: (s) => s.cloudReady, reason: 'Build a point cloud first' },
  dense: { ok: (s) => s.denseReady, reason: 'Build a dense cloud first' },
  twoClouds: { ok: (s) => s.editableCloudCount >= 2, reason: 'Needs at least two dense clouds' },
  mesh: { ok: (s) => s.meshReady, reason: 'Build a mesh first' },
  dem: { ok: (s) => s.demReady, reason: 'Build a DEM first' },
  // Only a DEM placed on the Earth has a reference DEM or a terrain under it.
  demCrs: { ok: (s) => !!s.demInCrs, reason: 'Georeference the model and rebuild the DEM first' },
  referenceDem: {
    ok: (s) => !!s.referenceDemReady,
    reason: 'Import a reference DEM first (Import ▸ Reference DEM / Ortho)',
  },
  // An ortho reprojects onto a SURFACE — a DEM or a mesh, not a DEM specifically.
  surface: { ok: (s) => s.demReady || s.meshReady, reason: 'Build a DEM or a mesh first' },
  ortho: { ok: (s) => s.orthoReady, reason: 'Build an orthophoto first' },
  products: { ok: (s) => s.productReady, reason: 'Build a DEM or orthophoto first' },
  poses: { ok: (s) => s.poseCount > 0, reason: 'Import camera poses first' },
  // Export ▸ Camera Poses writes the imported poses or the estimated ones.
  posesOrSparse: {
    ok: (s) => s.poseCount > 0 || s.sparseReady,
    reason: 'Import camera poses or build the sparse model first',
  },
  measurements: { ok: (s) => s.measurementCount > 0, reason: 'Save a measurement first (Tools ▸ Measure)' },
  footprints: {
    ok: (s) => s.footprintCount > 0,
    reason: 'Compute footprints first (Tools ▸ Model ▸ Footprints from poses)',
  },
  gcps: {
    ok: (s) => s.gcpCount > 0,
    reason: 'No GCPs yet — import a GCP file, or right-click the map or an image to add one',
  },
  selection: { ok: (s) => !!s.hasSelection, reason: 'Select an image first' },
  sensors: { ok: (s) => s.sensorCount > 0, reason: 'No sensors available' },
  filmSensor: { ok: (s) => s.filmSensorCount > 0, reason: 'Set at least one sensor to Film first' },
  fiducials: { ok: (s) => s.fiducialImageCount > 0, reason: 'Detect or mark fiducials first' },
  fiducialMarks: {
    ok: (s) => s.fiducialMarkSensorCount > 0,
    reason: 'No camera fiducial marks yet — enter them in the sensor table, or calibrate fiducials',
  },
  // The 2D map in the model frame has no CRS positions (useMapProducts).
  crsMap: {
    ok: (s) => !s.mapModelFrame,
    reason: 'The map shows the model frame, which has no CRS positions — turn off Model Frame',
  },
  // Tools that act on the view in front (`frontView`: 'image' | 'map' | 'viewer' |
  // 'raster' | ''). A mode belongs to one view, so the tool says which one it needs.
  imageView: { ok: (s) => s.frontView === 'image', reason: 'Open an image first' },
  gcpView: {
    ok: (s) => s.frontView === 'image' || (s.frontView === 'map' && !s.mapModelFrame),
    reason: 'Open an image, or the map in a CRS frame (not Model Frame)',
  },
  measureHost: {
    ok: (s) => s.frontView === 'raster' || (s.frontView === 'map' && s.mapRasterCount > 0),
    reason: 'Open a DEM or orthophoto, or show one on the map',
  },
}

export const AERIAL_ONLY_REASON = 'Only for aerial projects — an object capture has no coordinate system'

/**
 * Why a command (a ribbon table entry, or a console-only entry) is unavailable
 * in `state`, or '' when it can run: "coming soon", aerial-only, then the first
 * unmet prerequisite. The ribbon adds only its view-specific checks on top.
 */
export function commandReason(cmd, state) {
  if (cmd?.disabled) return 'Coming soon'
  if (cmd?.aerialOnly && state?.sceneType === 'object') return AERIAL_ONLY_REASON
  return guardReason(cmd?.needs, state)
}

// Ribbon command id → its table entry (the first one; duplicates are the same
// shared object, see ribbonTabs.js).
const RIBBON_BY_ID = new Map()
for (const c of leafCommands(allGroups())) if (c.id && !RIBBON_BY_ID.has(c.id)) RIBBON_BY_ID.set(c.id, c)

/** The ribbon entry a console command dispatches, or null for a console-only verb. */
export function ribbonCommandFor(cmd) {
  return RIBBON_BY_ID.get(cmd?.dispatch) ?? null
}

/** The console's guard: the ribbon command's own checks when it has one. */
export function consoleReason(cmd, state) {
  return commandReason(ribbonCommandFor(cmd) ?? cmd, state)
}

// Short names for ribbon commands, keyed by ribbon id: [name, ...aliases]. The id and
// the id as words are always aliases too, so this table only adds convenience — a
// command missing here is still reachable. A test pins every key to a ribbon id.
export const CONSOLE_NAMES = {
  'workflow-builder': ['workflow', 'recipe'],
  'detect-features': ['detect'],
  'match-features': ['match'],
  'reconstruct': ['sparse'],
  'compute-depth': ['depth', 'depthmaps'],
  'dense': ['dense'],
  'gen-dem': ['dem'],
  'gen-ortho': ['ortho'],
  'gen-mesh': ['mesh'],
  'find-gcps': ['find gcps', 'auto-gcps'],
  'georeference': ['georeference', 'georef'],
  'scale-bars': ['scale bars', 'scalebars'],
  'edit-gcps': ['edit gcps', 'mark gcps'],
  'auto-mask': ['automask'],
  'img-mask-edit': ['edit mask', 'mask edit'],
  'footprints-from-poses': ['footprints'],
  'detect-fiducials': ['fiducials'],
  'calibrate-fiducials': ['calibrate fiducials', 'fiducial-calibration'],
  'detect-reseau': ['reseau', 'detect reseau'],
  'split-panoramic': ['panoramic', 'split panoramic'],
  'image-quality': ['image quality', 'blur', 'sharpness'],
  'reduce-overlap': ['reduce overlap', 'disable photos', 'redundant'],
  'optimize-cameras': ['optimize'],
  'gradual-selection': ['gradual'],
  'set-region': ['region'],
  'orient-model': ['orient', 'level'],
  'view-select-lasso': ['lasso'],
  'view-select-rect': ['rectangle'],
  'estimate-normals': ['normals'],
  'classify-ground': ['ground', 'dtm'],
  'transform-cloud': ['transform'],
  'align-points': ['align pairs'],
  'align-icp': ['icp', 'align'],
  'filter-cloud': ['filter'],
  'crop-cloud': ['crop'],
  'merge-clouds': ['merge'],
  'clean-mesh': ['clean'],
  'texture-mesh': ['texture'],
  'decimate-mesh': ['decimate', 'simplify'],
  'smooth-mesh': ['smooth'],
  'dem-contours': ['contours'],
  'dem-derivatives': ['terrain', 'slope', 'hillshade', 'aspect'],
  'clip-raster': ['clip'],
  'measure-length': ['ruler', 'length'],
  'measure-area': ['area'],
  'measure-profile': ['profile'],
  'measure-volume': ['volume', 'cut fill'],
  'measure-3d': ['measure 3d'],
  'cloud-distance': ['cloud distance', 'c2c', 'c2m'],
  'cloud-section': ['section', 'slice'],
  'mesh-measure': ['mesh area', 'mesh volume'],
  'open-image-table': ['images', 'image-table'],
  'open-mask-manager': ['masks', 'mask-manager'],
  'open-sensor-table': ['sensors', 'sensor-table'],
  'open-pose-table': ['poses'],
  'open-gcp-table': ['gcps', 'gcp-table'],
  'open-match-list': ['matchlist', 'match-list'],
  'view-point-size': ['point size'],
  'view-camera-scale': ['camera size'],
  'import-images': ['import'],
  'import-video': ['import video', 'video'],
  'import-colmap': ['import colmap', 'colmap-import'],
  'import-project': ['import project', 'merge projects', 'merge blocks'],
  'eval-overview': ['report', 'quality'],
  'open-project-settings': ['project settings', 'project properties'],
  'save-project-file': ['export project', 'project file', 'save copy'],
  'toggle-console': ['console'],
  'open-settings': ['settings'],
  'open-glossary': ['glossary'],
  'open-guide': ['guide'],
  'open-about': ['about'],
  'open-system-info': ['system info', 'diagnostics'],
}

// Dispatch ids the console reaches that have no ribbon button of their own.
const CONSOLE_ONLY_DISPATCH = [
  { dispatch: 'view-viewer', names: ['viewer', '3d'], help: 'Switch to the 3D viewer' },
  { dispatch: 'view-map', names: ['map', '2d'], help: 'Switch to the map view' },
  {
    dispatch: 'toggle-theme',
    names: ['theme', 'dark mode', 'light mode'],
    help: 'Cycle appearance: system / light / dark',
  },
]

// The stages `run` chains, by the word typed → workflow block id (core/workflow.js).
export const RUN_STAGES = {
  detect: 'detect-features',
  match: 'match-features',
  sparse: 'reconstruct',
  reconstruct: 'reconstruct',
  depth: 'compute-depth',
  dense: 'dense',
  dem: 'gen-dem',
  ortho: 'gen-ortho',
  mesh: 'gen-mesh',
  texture: 'texture-mesh',
}

// Console-only verbs: they take arguments and act through the console environment
// (core/help/console.js), not a ribbon command. `usage` lines are what `help <verb>`
// and a malformed call print.
export const VERBS = [
  {
    verb: 'help',
    names: ['help', '?'],
    usage: ['help', 'help <command>', 'help <tab>   (e.g. help tools)', 'help all'],
    help: "List commands, or show one command's usage",
  },
  { verb: 'clear', names: ['clear', 'cls'], usage: ['clear'], help: 'Clear the console' },
  {
    verb: 'run',
    names: ['run'],
    needs: ['project'],
    usage: [
      `run <stage> [<stage> …]   stages: ${[...new Set(Object.keys(RUN_STAGES))].join(' ')}`,
      'run workflow <name>',
    ],
    help: 'Run pipeline stages (default settings) or a saved workflow through the workflow runner',
  },
  { verb: 'continue', names: ['continue'], usage: ['continue'], help: 'Continue a paused workflow' },
  { verb: 'reuse', names: ['reuse'], usage: ['reuse'], help: 'Keep the existing output a paused workflow asks about' },
  { verb: 'stop', names: ['stop'], usage: ['stop'], help: 'Stop the running workflow' },
  {
    verb: 'stats',
    names: ['stats', 'status'],
    needs: ['project'],
    usage: ['stats', 'stats matches'],
    help: 'Project counts; "stats matches" for the match graph',
  },
  {
    verb: 'set',
    names: ['set'],
    usage: [
      'set',
      'set <group>   (sfm, match: list the keys)',
      'set <group>.<key> <value>',
      'set <group>.<key> default',
    ],
    help: 'Override an internal tuning value for this session',
  },
  {
    verb: 'pair',
    names: ['pair'],
    needs: ['matches'],
    usage: ['pair disable <imageA> <imageB>', 'pair enable <imageA> <imageB>'],
    help: 'Exclude a verified pair from reconstruction, or restore it',
  },
  {
    verb: 'select',
    names: ['select'],
    needs: ['images'],
    usage: ['select <image name>'],
    help: 'Select an image (a unique start of its name is enough)',
  },
]

const idWords = (id) => id.replace(/[-:]/g, ' ')

// The command catalogue: verbs, then every ribbon command (ribbon order), then the
// console-only dispatches. Each: { name, aliases, group, help, where?, dispatch?,
// verb?, usage?, needs?, stepper?, short? }. `name` is what help shows; `aliases` are
// the other typeable spellings (lower case); `short` marks a hand-named command (the
// `help` overview lists those). Ribbon `disabled` ("coming soon") rows are left out.
function buildCommands() {
  const out = []
  for (const v of VERBS) {
    out.push({
      name: v.names[0],
      aliases: v.names.slice(1),
      verb: v.verb,
      group: 'Console',
      help: v.help,
      usage: v.usage,
      ...(v.needs ? { needs: v.needs } : {}),
    })
  }
  for (const { cmd, tab, path } of ribbonEntries()) {
    if (cmd.disabled) continue
    const short = CONSOLE_NAMES[cmd.id] ?? []
    const basemap = cmd.id.startsWith('map-basemap:') ? [`basemap ${cmd.id.slice('map-basemap:'.length)}`] : []
    const keys = [...new Set([...short, ...basemap, idWords(cmd.id), cmd.id].map((k) => k.toLowerCase()))]
    const where = `${path} ▸ ${labelText(cmd)}`
    out.push({
      name: keys[0],
      aliases: keys.slice(1),
      dispatch: cmd.id,
      group: tab,
      where,
      // The Export tab's ids already read as commands ("export cloud"), so they list too.
      help: cmd.blurb ?? where,
      short: short.length > 0 || cmd.id.startsWith('export-'),
      ...(cmd.stepper
        ? {
            stepper: { min: cmd.min, max: cmd.max, step: cmd.step },
            usage: [`${keys[0]} <value>   (${cmd.min} – ${cmd.max})`],
          }
        : {}),
    })
  }
  for (const c of CONSOLE_ONLY_DISPATCH) {
    out.push({
      name: c.names[0],
      aliases: c.names.slice(1),
      dispatch: c.dispatch,
      group: 'View',
      help: c.help,
      short: true,
    })
  }
  return out
}
export const COMMANDS = buildCommands()

// name/alias (lowercased) -> command. Built once at module load; a key claimed by two
// commands keeps the first and is listed in KEY_COLLISIONS (a test keeps that empty).
const BY_NAME = new Map()
export const KEY_COLLISIONS = []
for (const cmd of COMMANDS) {
  for (const key of [cmd.name, ...cmd.aliases]) {
    const k = key.toLowerCase()
    if (BY_NAME.has(k) && BY_NAME.get(k) !== cmd) KEY_COLLISIONS.push(k)
    else BY_NAME.set(k, cmd)
  }
}

// The longest invocation in tokens ("export camera fiducials" is 3); the resolver
// tries that many, then fewer.
const MAX_NAME_TOKENS = Math.max(...[...BY_NAME.keys()].map((k) => k.split(' ').length))

/** Split a raw line into whitespace-delimited tokens (empties dropped). */
export function tokenize(line) {
  return String(line ?? '')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
}

/**
 * Resolve a raw command line to a command + its argument tokens.
 * Tries the longest name first (so "export cloud x" beats a bare "export").
 * @returns {{ cmd, name, args }} on hit; {{ error:'empty' }} for blank input;
 *          {{ error:'unknown', name, suggestions }} when nothing matches.
 */
export function resolveCommand(line) {
  const tokens = tokenize(line)
  if (tokens.length === 0) return { error: 'empty' }
  for (let n = Math.min(MAX_NAME_TOKENS, tokens.length); n >= 1; n--) {
    const key = tokens.slice(0, n).join(' ').toLowerCase()
    const cmd = BY_NAME.get(key)
    if (cmd) return { cmd, name: key, args: tokens.slice(n) }
  }
  const name = tokens[0].toLowerCase()
  return { error: 'unknown', name, suggestions: suggestFor(name) }
}

/** Look up a command by exact name/alias (for `help <cmd>`). */
export function getCommand(name) {
  return (
    BY_NAME.get(
      String(name ?? '')
        .trim()
        .toLowerCase()
        .replace(/\s+/g, ' '),
    ) ?? null
  )
}

/**
 * First unmet prerequisite message for `needs` given `state`, or '' if all met.
 * Same wording as the ribbon's disabled-button tooltip.
 */
export function guardReason(needs, state) {
  for (const need of needs ?? []) {
    const check = NEED_CHECKS[need]
    if (check && !check.ok(state ?? {})) return check.reason
  }
  return ''
}

/**
 * All invocation strings (names + aliases) starting with `prefix`, sorted. With
 * `argCompletions` ({ verb: (argPrefix) → [argument strings] }), a verb's arguments
 * complete too once the verb itself is typed.
 */
export function completions(prefix, argCompletions = null) {
  const p = String(prefix ?? '')
    .trimStart()
    .toLowerCase()
  const out = []
  for (const key of BY_NAME.keys()) {
    if (key.startsWith(p)) out.push(key)
  }
  const res = argCompletions && /\s/.test(p) ? resolveCommand(p) : null
  const complete = res?.cmd?.verb && argCompletions[res.cmd.verb]
  if (complete) {
    const rest = p.slice(res.name.length).trimStart()
    for (const arg of complete(rest)) if (arg.toLowerCase().startsWith(rest)) out.push(`${res.name} ${arg}`)
  }
  return [...new Set(out)].sort()
}

/** Longest common prefix of a list of strings ('' if none / no shared prefix). */
export function commonPrefix(strings) {
  if (!strings || strings.length === 0) return ''
  let prefix = strings[0]
  for (const s of strings) {
    while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1)
    if (!prefix) return ''
  }
  return prefix
}

// Close-enough unknown-command suggestions: shared prefix or small edit distance,
// the verbs and hand-named commands first.
function suggestFor(name) {
  const scored = []
  for (const cmd of COMMANDS) {
    const d = editDistance(name, cmd.name.toLowerCase())
    if (cmd.name.toLowerCase().startsWith(name) || d <= 2)
      scored.push({ name: cmd.name, d: d + (cmd.short || cmd.verb ? 0 : 0.5) })
  }
  scored.sort((a, b) => a.d - b.d)
  return scored.slice(0, 3).map((s) => s.name)
}

function editDistance(a, b) {
  const m = a.length,
    n = b.length
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)])
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

// One overview line: the name, the hand-made aliases (not the id spellings), and
// where the command lives in the ribbon.
function overviewLine(cmd) {
  const aliases = cmd.aliases.filter((a) => a !== cmd.dispatch && a !== idWords(cmd.dispatch ?? ''))
  return `  ${cmd.name}${aliases.length ? `  (${aliases.join(', ')})` : ''} — ${cmd.where ?? cmd.help}`
}

/**
 * The `help` overview. No topic: the verbs and every hand-named command, grouped by
 * ribbon tab, plus how to see the rest. 'all': every command. A tab name ('tools',
 * 'export', 'dem' …): that tab's commands. → lines, or null for an unknown topic.
 */
export function helpLines(topic = '') {
  const t = String(topic ?? '')
    .trim()
    .toLowerCase()
  const groups = [...new Set(COMMANDS.map((c) => c.group))]
  const pick = !t || t === 'all' ? groups : groups.filter((g) => g.toLowerCase() === t || g.toLowerCase().startsWith(t))
  if (!pick.length) return null
  const lines = []
  let hidden = 0
  for (const g of pick) {
    const rows = COMMANDS.filter((c) => c.group === g)
    const shown = t ? rows : rows.filter((c) => c.short || c.verb)
    hidden += rows.length - shown.length
    if (!shown.length) continue
    lines.push(`— ${g} —`)
    for (const c of shown) lines.push(overviewLine(c))
  }
  if (hidden) lines.push(`${hidden} more ribbon commands: "help <tab>" (e.g. help tools) or "help all".`)
  return lines
}

/** Detailed help for one command (usage, ribbon location, aliases, requires), or null. */
export function helpFor(name) {
  const cmd = getCommand(name)
  if (!cmd) return null
  const lines = [`${cmd.name} — ${cmd.help}`]
  for (const u of cmd.usage ?? []) lines.push(`  usage: ${u}`)
  if (cmd.where && cmd.where !== cmd.help) lines.push(`  ribbon: ${cmd.where}`)
  if (cmd.aliases.length) lines.push(`  also: ${cmd.aliases.join(', ')}`)
  const needs = (ribbonCommandFor(cmd) ?? cmd).needs ?? []
  if (needs.length) lines.push(`  requires: ${needs.join(', ')}`)
  return lines
}

// Pure command registry for the DevConsole command line (power-user front end).
//
// This is a text front end over the SAME command dispatch the ribbon uses
// (`handleCommand(id)` in App.vue): every entry here maps a typed command name
// to a ribbon command `dispatch` id. No Vue / Pinia / DOM here — plain data in,
// plain data out — so it stays unit-testable and matches the "core is pure" rule
// in CLAUDE.md. The impure binding (calling handleCommand, reading store state,
// echoing to the log) lives in `composables/useCommands.js`.
//
// Guard parity: a console command that dispatches a ribbon command takes that
// command's prerequisites (`needs`, `aerialOnly`, `disabled`) straight from the
// ribbon table (`consoleReason`), so the two front ends cannot drift — copies of
// the needs here once did. Only console-only verbs carry their own `needs`.

import { allGroups, leafCommands } from './ribbonTabs.js'

// Prerequisite checks: the ONE table behind both gates, the ribbon's greyed
// buttons/menu rows (Ribbon.vue `needs: [...]`) and this command line, so the two
// can never disagree. Each: does `state` (App.vue `commandState`) satisfy it, and
// why not. A missing state field reads as unmet.
export const NEED_CHECKS = {
  project:   { ok: (s) => !!s.projectReady, reason: 'Open a project first' },
  images:    { ok: (s) => s.imageCount   > 0, reason: 'Import images first' },
  imagesReady: { ok: (s) => !s.imagesLoading, reason: 'Images still loading…' },
  keypoints: { ok: (s) => s.kpImageCount > 0, reason: 'Detect keypoints first' },
  matches:   { ok: (s) => s.matchCount   > 0, reason: 'Run feature matching first' },
  sparse:    { ok: (s) => s.sparseReady,      reason: 'Build the sparse model first' },
  depthMaps: { ok: (s) => s.depthMapCount > 0, reason: 'Compute depth maps first' },
  cloud:     { ok: (s) => s.cloudReady,       reason: 'Build a point cloud first' },
  dense:     { ok: (s) => s.denseReady,       reason: 'Build a dense cloud first' },
  twoClouds: { ok: (s) => s.editableCloudCount >= 2, reason: 'Needs at least two dense clouds' },
  mesh:      { ok: (s) => s.meshReady,        reason: 'Build a mesh first' },
  dem:     { ok: (s) => s.demReady,         reason: 'Build a DEM first' },
  // An ortho reprojects onto a SURFACE — a DEM or a mesh, not a DEM specifically.
  surface:   { ok: (s) => s.demReady || s.meshReady, reason: 'Build a DEM or a mesh first' },
  ortho:     { ok: (s) => s.orthoReady,       reason: 'Build an orthophoto first' },
  products:  { ok: (s) => s.productReady,     reason: 'Build a DEM or orthophoto first' },
  poses:     { ok: (s) => s.poseCount   > 0,  reason: 'Import camera poses first' },
  footprints: { ok: (s) => s.footprintCount > 0, reason: 'Import or generate footprints first' },
  gcps:      { ok: (s) => s.gcpCount > 0,
               reason: 'No GCPs yet — import a GCP file, or right-click the map or an image to add one' },
  selection: { ok: (s) => !!s.hasSelection,   reason: 'Select an image first' },
  sensors:   { ok: (s) => s.sensorCount > 0,  reason: 'No sensors available' },
  filmSensor: { ok: (s) => s.filmSensorCount > 0, reason: 'Set at least one sensor to Film first' },
  // The 2D map in the model frame has no CRS positions (useMapProducts).
  crsMap:    { ok: (s) => !s.mapModelFrame, reason: 'The map shows the model frame, which has no CRS positions — turn off Model Frame' },
  // Tools that act on the view in front (`frontView`: 'image' | 'map' | 'viewer' |
  // 'raster' | ''). A mode belongs to one view, so the tool says which one it needs.
  imageView: { ok: (s) => s.frontView === 'image', reason: 'Open an image first' },
  gcpView:   { ok: (s) => s.frontView === 'image' || (s.frontView === 'map' && !s.mapModelFrame),
               reason: 'Open an image, or the map in a CRS frame (not Model Frame)' },
  measureHost: { ok: (s) => s.frontView === 'raster' || (s.frontView === 'map' && s.mapRasterCount > 0),
                 reason: 'Open a DEM or orthophoto, or show one on the map' },
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

// The command catalogue. `group` only drives help layout. `dispatch` is the
// ribbon command id emitted to App.vue's handleCommand(). Names/aliases are the
// tokens a user types (case-insensitive). Multi-word names (e.g. "export cloud")
// are resolved before single-word ones so `export` + subcommand works.
export const COMMANDS = [
  // --- Pipeline ---
  { name: 'workflow', aliases: ['workflow-builder', 'recipe'], dispatch: 'workflow-builder', group: 'Pipeline', help: 'Open the visual workflow builder' },
  { name: 'detect',   aliases: ['detect-features'], dispatch: 'detect-features', group: 'Pipeline', help: 'Open the feature-detection dialog' },
  { name: 'match',    aliases: ['match-features'],  dispatch: 'match-features',  group: 'Pipeline', help: 'Open the feature-matching dialog' },
  { name: 'sparse',   aliases: ['reconstruct'],     dispatch: 'reconstruct',     group: 'Pipeline', help: 'Open the sparse reconstruction dialog' },
  { name: 'depth',    aliases: ['depthmaps'],       dispatch: 'compute-depth',   group: 'Pipeline', help: 'Open the depth-map dialog' },
  { name: 'dense',    aliases: [],                  dispatch: 'dense',           group: 'Pipeline', help: 'Open the dense reconstruction dialog' },
  { name: 'dem',      aliases: [],                  dispatch: 'gen-dem',         group: 'Pipeline', help: 'Open the DEM generation dialog' },
  { name: 'ortho',    aliases: [],                  dispatch: 'gen-ortho',       group: 'Pipeline', help: 'Open the orthophoto dialog' },
  { name: 'mesh',     aliases: [],                  dispatch: 'gen-mesh',        group: 'Pipeline', help: 'Open the mesh dialog' },

  // --- Tools ---
  { name: 'find gcps', aliases: ['auto-gcps'],       dispatch: 'find-gcps',          group: 'Tools', help: 'Find and review reference-ortho control candidates' },
  { name: 'georeference', aliases: ['georef'],       dispatch: 'georeference',       group: 'Tools', help: 'Adjust with GCPs or transform the current model to the project CRS' },
  { name: 'scale bars', aliases: ['scalebars'],      dispatch: 'scale-bars',         group: 'Tools', help: 'Scale the model with known distances' },
  { name: 'edit gcps', aliases: ['mark gcps'],       dispatch: 'edit-gcps',          group: 'Tools', help: 'Toggle GCP editing on the image or map in front' },
  { name: 'automask',     aliases: ['auto-mask'],   dispatch: 'auto-mask',          group: 'Tools', help: 'Open the auto-mask dialog' },
  { name: 'edit mask',    aliases: ['mask edit'],   dispatch: 'img-mask-edit',      group: 'Tools', help: 'Toggle mask painting on the image in front' },
  { name: 'footprints',   aliases: [],              dispatch: 'footprints-from-poses', group: 'Tools', help: 'Build footprints from poses' },
  { name: 'fiducials',    aliases: ['detect-fiducials'], dispatch: 'detect-fiducials', group: 'Tools', help: 'Auto-detect fiducial marks on film scans' },
  { name: 'calibrate-fiducials', aliases: ['fiducial-calibration'], dispatch: 'calibrate-fiducials', group: 'Tools', help: 'Calibrate detected film fiducials' },
  { name: 'image quality', aliases: ['blur', 'sharpness'], dispatch: 'image-quality', group: 'Tools', help: 'Score image sharpness and exposure' },
  { name: 'optimize',     aliases: ['optimize cameras'], dispatch: 'optimize-cameras', group: 'Tools', help: 'Re-run bundle adjustment with the focal length free' },
  { name: 'gradual',      aliases: ['gradual selection'], dispatch: 'gradual-selection', group: 'Tools', help: 'Remove weak tie points from the sparse model' },
  { name: 'region',       aliases: [],               dispatch: 'set-region',          group: 'Tools', help: 'Set the box that bounds depth maps, fusion, mesh and DEM' },
  { name: 'orient',       aliases: ['orient model', 'level'], dispatch: 'orient-model', group: 'Tools', help: 'Set up, origin and heading of the local frame' },
  { name: 'select',       aliases: ['lasso'],        dispatch: 'view-select-lasso',   group: 'Tools', help: 'Lasso-select dense points in the 3D view' },
  { name: 'normals',      aliases: ['estimate normals'], dispatch: 'estimate-normals', group: 'Tools', help: 'Estimate per-point normals on a dense cloud' },
  { name: 'transform',    aliases: [],               dispatch: 'transform-cloud',     group: 'Tools', help: 'Move, rotate, scale or matrix-transform a cloud' },
  { name: 'align pairs',  aliases: ['align points'], dispatch: 'align-points',        group: 'Tools', help: 'Align a cloud by picking point pairs' },
  { name: 'icp',          aliases: ['align'],        dispatch: 'align-icp',           group: 'Tools', help: 'Refine an alignment to a reference cloud or mesh' },
  { name: 'clean mesh',   aliases: ['clean'],        dispatch: 'clean-mesh',          group: 'Tools', help: 'Remove specks and bridges, fill holes' },
  { name: 'decimate',     aliases: ['simplify'],     dispatch: 'decimate-mesh',       group: 'Tools', help: 'Reduce a mesh to a target triangle count' },
  { name: 'smooth',       aliases: [],               dispatch: 'smooth-mesh',         group: 'Tools', help: 'Taubin-smooth a mesh' },
  { name: 'contours',     aliases: [],               dispatch: 'dem-contours',        group: 'Tools', help: 'Export contour lines from the DEM' },
  { name: 'terrain',      aliases: ['slope', 'hillshade', 'aspect'], dispatch: 'dem-derivatives', group: 'Tools', help: 'Export slope, aspect and hillshade rasters' },
  { name: 'clip',         aliases: [],               dispatch: 'clip-raster',         group: 'Tools', help: 'Export the DEM or ortho clipped to a polygon' },

  // --- Measure (Tools ▸ Measure ▾) ---
  { name: 'ruler',        aliases: ['length'],       dispatch: 'measure-length',      group: 'Measure', help: 'Measure a distance on the DEM / orthophoto in front' },
  { name: 'area',         aliases: [],               dispatch: 'measure-area',        group: 'Measure', help: 'Measure an area on the DEM / orthophoto in front' },
  { name: 'profile',      aliases: [],               dispatch: 'measure-profile',     group: 'Measure', help: 'Draw an elevation profile on the DEM in front' },
  { name: 'volume',       aliases: ['cut fill'],     dispatch: 'measure-volume',      group: 'Measure', help: 'Measure a cut/fill volume on the DEM in front' },
  { name: 'cloud distance', aliases: ['c2c', 'c2m'], dispatch: 'cloud-distance',      group: 'Measure', help: 'Per-point distance to another cloud or a mesh' },
  { name: 'section',      aliases: ['slice'],        dispatch: 'cloud-section',       group: 'Measure', help: 'Cut a vertical slice of a cloud and export its profile' },
  { name: 'mesh area',    aliases: ['mesh volume'],  dispatch: 'mesh-measure',        group: 'Measure', help: 'Surface area and enclosed volume of a mesh' },

  // --- Tables / views ---
  { name: 'images',   aliases: ['image-table'],     dispatch: 'open-image-table',  group: 'View', help: 'Open the image table' },
  { name: 'masks',    aliases: ['mask-manager'],    dispatch: 'open-mask-manager', group: 'View', help: 'Open the mask manager' },
  { name: 'sensors',  aliases: ['sensor-table'],    dispatch: 'open-sensor-table', group: 'View', help: 'Open the sensor table' },
  { name: 'gcps',     aliases: ['gcp-table'],       dispatch: 'open-gcp-table',    group: 'View', help: 'Open the GCP table' },
  { name: 'matchlist', aliases: ['match-list'],     dispatch: 'open-match-list',   group: 'View', help: 'Open the match list' },
  { name: 'viewer',   aliases: ['3d'],              dispatch: 'view-viewer',       group: 'View', help: 'Switch to the 3D viewer' },
  { name: 'map',      aliases: ['2d'],              dispatch: 'view-map',          group: 'View', help: 'Switch to the map view' },

  // --- Import ---
  { name: 'import',   aliases: ['import-images'],   dispatch: 'import-images',     group: 'Import', help: 'Import images' },
  { name: 'import colmap', aliases: ['colmap-import'], dispatch: 'import-colmap',  group: 'Import', help: 'Import an SfM project (COLMAP and others)' },

  // --- Export (multi-word: "export <what>") ---
  { name: 'export cloud',     dispatch: 'export-cloud',     group: 'Export', help: 'Export the point cloud' },
  { name: 'export mesh',      dispatch: 'export-mesh',      group: 'Export', help: 'Export the mesh' },
  { name: 'export model',     dispatch: 'export-model',     group: 'Export', help: 'Export the model JSON' },
  { name: 'export dem',       dispatch: 'export-dem',       group: 'Export', help: 'Export the DEM' },
  { name: 'export ortho',     dispatch: 'export-ortho',     group: 'Export', help: 'Export the orthophoto' },
  { name: 'export cameras',   dispatch: 'export-cameras',   group: 'Export', help: 'Export camera poses' },
  { name: 'export sensors',   dispatch: 'export-sensors',   group: 'Export', help: 'Export sensors' },
  { name: 'export keypoints', dispatch: 'export-keypoints', group: 'Export', help: 'Export keypoints' },
  { name: 'export matches',   dispatch: 'export-matches',   group: 'Export', help: 'Export matches' },

  // --- App ---
  { name: 'project settings', aliases: ['project properties'], dispatch: 'open-project-settings', group: 'App', help: 'Open settings for the current project' },
  { name: 'settings', aliases: [],                  dispatch: 'open-settings', group: 'App', help: 'Open settings' },
  { name: 'theme',    aliases: ['dark mode', 'light mode'], dispatch: 'toggle-theme', group: 'App', help: 'Cycle appearance: system / light / dark' },
  { name: 'glossary', aliases: [],                  dispatch: 'open-glossary', group: 'App', help: 'Open the glossary' },
  { name: 'about',    aliases: [],                  dispatch: 'open-about',    group: 'App', help: 'Open the about dialog' },
  { name: 'system info', aliases: ['diagnostics'],  dispatch: 'open-system-info', group: 'App', help: 'Open system / hardware diagnostics' },
]

// name/alias (lowercased) -> command. Built once at module load.
const BY_NAME = new Map()
for (const cmd of COMMANDS) {
  BY_NAME.set(cmd.name.toLowerCase(), cmd)
  for (const a of cmd.aliases ?? []) BY_NAME.set(a.toLowerCase(), cmd)
}

// Longest invocation is 2 tokens ("export cloud"); resolver tries 2 then 1.
const MAX_NAME_TOKENS = 2

/** Split a raw line into whitespace-delimited tokens (empties dropped). */
export function tokenize(line) {
  return String(line ?? '').trim().split(/\s+/).filter(Boolean)
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
  return BY_NAME.get(String(name ?? '').trim().toLowerCase()) ?? null
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

/** All invocation strings (names + aliases) starting with `prefix`, sorted. */
export function completions(prefix) {
  const p = String(prefix ?? '').trimStart().toLowerCase()
  const out = []
  for (const key of BY_NAME.keys()) {
    if (key.startsWith(p)) out.push(key)
  }
  return out.sort()
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

// Close-enough unknown-command suggestions: shared prefix or small edit distance.
function suggestFor(name) {
  const scored = []
  for (const cmd of COMMANDS) {
    const d = editDistance(name, cmd.name.toLowerCase())
    if (cmd.name.toLowerCase().startsWith(name) || d <= 2) scored.push({ name: cmd.name, d })
  }
  scored.sort((a, b) => a.d - b.d)
  return scored.slice(0, 3).map((s) => s.name)
}

function editDistance(a, b) {
  const m = a.length, n = b.length
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

/** One "name — help" line per command, grouped, for the `help` overview. */
export function helpLines() {
  const lines = []
  let lastGroup = null
  for (const cmd of COMMANDS) {
    if (cmd.group !== lastGroup) {
      lines.push(`— ${cmd.group ?? 'Other'} —`)
      lastGroup = cmd.group
    }
    const aliases = (cmd.aliases ?? []).length ? `  (${cmd.aliases.join(', ')})` : ''
    lines.push(`  ${cmd.name}${aliases} — ${cmd.help}`)
  }
  return lines
}

/** Detailed help for one command, or null if unknown. */
export function helpFor(name) {
  const cmd = getCommand(name)
  if (!cmd) return null
  const lines = [`${cmd.name} — ${cmd.help}`]
  if ((cmd.aliases ?? []).length) lines.push(`  aliases: ${cmd.aliases.join(', ')}`)
  const needs = (ribbonCommandFor(cmd) ?? cmd).needs ?? []
  if (needs.length) lines.push(`  requires: ${needs.join(', ')}`)
  return lines
}

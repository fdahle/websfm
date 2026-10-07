// Pure command registry for the DevConsole command line (power-user front end).
//
// This is a text front end over the SAME command dispatch the ribbon uses
// (`handleCommand(id)` in App.vue): every entry here maps a typed command name
// to a ribbon command `dispatch` id. No Vue / Pinia / DOM here — plain data in,
// plain data out — so it stays unit-testable and matches the "core is pure" rule
// in CLAUDE.md. The impure binding (calling handleCommand, reading store state,
// echoing to the log) lives in `composables/useCommands.js`.
//
// Guard parity: `needs` lists prerequisite keys; `guardReason(needs, state)`
// returns the same "do X first" message the ribbon shows for a disabled button,
// so `dense` typed before depth maps exist explains itself instead of no-op'ing.

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
}

// The command catalogue. `group` only drives help layout. `dispatch` is the
// ribbon command id emitted to App.vue's handleCommand(). Names/aliases are the
// tokens a user types (case-insensitive). Multi-word names (e.g. "export cloud")
// are resolved before single-word ones so `export` + subcommand works.
export const COMMANDS = [
  // --- Pipeline ---
  { name: 'workflow', aliases: ['workflow-builder', 'recipe'], dispatch: 'workflow-builder', needs: ['project'], group: 'Pipeline', help: 'Open the visual workflow builder' },
  { name: 'detect',   aliases: ['detect-features'], dispatch: 'detect-features', needs: ['images', 'imagesReady'], group: 'Pipeline', help: 'Open the feature-detection dialog' },
  { name: 'match',    aliases: ['match-features'],  dispatch: 'match-features',  needs: ['keypoints'], group: 'Pipeline', help: 'Open the feature-matching dialog' },
  { name: 'sparse',   aliases: ['reconstruct'],     dispatch: 'reconstruct',     needs: ['matches'],   group: 'Pipeline', help: 'Open the sparse reconstruction dialog' },
  { name: 'depth',    aliases: ['depthmaps'],       dispatch: 'compute-depth',   needs: ['sparse'],    group: 'Pipeline', help: 'Open the depth-map dialog' },
  { name: 'dense',    aliases: [],                  dispatch: 'dense',           needs: ['depthMaps'], group: 'Pipeline', help: 'Open the dense reconstruction dialog' },
  { name: 'dem',      aliases: [],                  dispatch: 'gen-dem',         needs: ['cloud'],     group: 'Pipeline', help: 'Open the DEM generation dialog' },
  { name: 'ortho',    aliases: [],                  dispatch: 'gen-ortho',       needs: ['surface', 'depthMaps'], group: 'Pipeline', help: 'Open the orthophoto dialog' },

  // --- Tools ---
  { name: 'find gcps', aliases: ['auto-gcps'],       dispatch: 'find-gcps',          needs: ['sparse'], group: 'Tools', help: 'Find and review reference-ortho control candidates' },
  { name: 'georeference', aliases: ['georef'],       dispatch: 'georeference',       needs: ['sparse'], group: 'Tools', help: 'Adjust with GCPs or transform the current model to the project CRS' },
  { name: 'automask',     aliases: ['auto-mask'],   dispatch: 'auto-mask',          needs: ['images', 'imagesReady'], group: 'Tools', help: 'Open the auto-mask dialog' },
  { name: 'footprints',   aliases: [],              dispatch: 'footprints-from-poses', needs: ['poses', 'sensors'], group: 'Tools', help: 'Build footprints from poses' },
  { name: 'fiducials',    aliases: ['detect-fiducials'], dispatch: 'detect-fiducials', needs: ['filmSensor'], group: 'Tools', help: 'Auto-detect fiducial marks on film scans' },
  { name: 'calibrate-fiducials', aliases: ['fiducial-calibration'], dispatch: 'calibrate-fiducials', needs: ['filmSensor'], group: 'Tools', help: 'Calibrate detected film fiducials' },
  { name: 'image quality', aliases: ['blur', 'sharpness'], dispatch: 'image-quality', needs: ['images', 'imagesReady'], group: 'Tools', help: 'Score image sharpness and exposure' },
  { name: 'optimize',     aliases: ['optimize cameras'], dispatch: 'optimize-cameras', needs: ['sparse'], group: 'Tools', help: 'Re-run bundle adjustment with the focal length free' },
  { name: 'gradual',      aliases: ['gradual selection'], dispatch: 'gradual-selection', needs: ['sparse'], group: 'Tools', help: 'Remove weak tie points from the sparse model' },
  { name: 'region',       aliases: [],               dispatch: 'set-region',          needs: ['sparse'], group: 'Tools', help: 'Set the box that bounds depth maps, fusion, mesh and DEM' },
  { name: 'orient',       aliases: ['orient model', 'level'], dispatch: 'orient-model', needs: ['sparse'], group: 'Tools', help: 'Set up, origin and heading of the local frame' },
  { name: 'normals',      aliases: ['estimate normals'], dispatch: 'estimate-normals', needs: ['dense'], group: 'Tools', help: 'Estimate per-point normals on a dense cloud' },
  { name: 'transform',    aliases: [],               dispatch: 'transform-cloud',     needs: ['dense'], group: 'Tools', help: 'Move, rotate, scale or matrix-transform a cloud' },
  { name: 'align pairs',  aliases: ['align points'], dispatch: 'align-points',        needs: ['dense'], group: 'Tools', help: 'Align a cloud by picking point pairs' },
  { name: 'icp',          aliases: ['align'],        dispatch: 'align-icp',           needs: ['dense'], group: 'Tools', help: 'Refine an alignment to a reference cloud or mesh' },
  { name: 'distance',     aliases: ['c2c', 'c2m'],   dispatch: 'cloud-distance',      needs: ['dense'], group: 'Tools', help: 'Per-point distance to another cloud or a mesh' },
  { name: 'section',      aliases: ['profile'],      dispatch: 'cloud-section',       needs: ['dense'], group: 'Tools', help: 'Cut a vertical slice and export its profile' },
  { name: 'clean mesh',   aliases: ['clean'],        dispatch: 'clean-mesh',          needs: ['mesh'],  group: 'Tools', help: 'Remove specks and bridges, fill holes' },
  { name: 'decimate',     aliases: ['simplify'],     dispatch: 'decimate-mesh',       needs: ['mesh'],  group: 'Tools', help: 'Reduce a mesh to a target triangle count' },
  { name: 'smooth',       aliases: [],               dispatch: 'smooth-mesh',         needs: ['mesh'],  group: 'Tools', help: 'Taubin-smooth a mesh' },
  { name: 'mesh area',    aliases: ['volume'],       dispatch: 'mesh-measure',        needs: ['mesh'],  group: 'Tools', help: 'Surface area and enclosed volume of a mesh' },
  { name: 'contours',     aliases: [],               dispatch: 'dem-contours',        needs: ['dem'],   group: 'Tools', help: 'Export contour lines from the DEM' },
  { name: 'terrain',      aliases: ['slope', 'hillshade', 'aspect'], dispatch: 'dem-derivatives', needs: ['dem'], group: 'Tools', help: 'Export slope, aspect and hillshade rasters' },
  { name: 'clip',         aliases: [],               dispatch: 'clip-raster',         needs: ['products'], group: 'Tools', help: 'Export the DEM or ortho clipped to a polygon' },

  // --- Tables / views ---
  { name: 'images',   aliases: ['image-table'],     dispatch: 'open-image-table',  needs: ['images'],  group: 'View', help: 'Open the image table' },
  { name: 'masks',    aliases: ['mask-manager'],    dispatch: 'open-mask-manager', needs: ['images'],  group: 'View', help: 'Open the mask manager' },
  { name: 'sensors',  aliases: ['sensor-table'],    dispatch: 'open-sensor-table', needs: ['sensors'], group: 'View', help: 'Open the sensor table' },
  { name: 'gcps',     aliases: ['gcp-table'],       dispatch: 'open-gcp-table',                       group: 'View', help: 'Open the GCP table' },
  { name: 'matchlist', aliases: ['match-list'],     dispatch: 'open-match-list',   needs: ['matches'], group: 'View', help: 'Open the match list' },
  { name: 'viewer',   aliases: ['3d'],              dispatch: 'view-viewer',       group: 'View', help: 'Switch to the 3D viewer' },
  { name: 'map',      aliases: ['2d'],              dispatch: 'view-map',          group: 'View', help: 'Switch to the map view' },

  // --- Import ---
  { name: 'import',   aliases: ['import-images'],   dispatch: 'import-images',     group: 'Import', help: 'Import images' },
  { name: 'import colmap', aliases: ['colmap-import'], dispatch: 'import-colmap', needs: ['images'], group: 'Import', help: 'Import a COLMAP sparse model (.zip or .txt set)' },

  // --- Export (multi-word: "export <what>") ---
  { name: 'export cloud',     dispatch: 'export-cloud',     needs: ['cloud'],     group: 'Export', help: 'Export the point cloud' },
  { name: 'export model',     dispatch: 'export-model',     needs: ['cloud'],     group: 'Export', help: 'Export the model JSON' },
  { name: 'export dem',       dispatch: 'export-dem',       needs: ['dem'],       group: 'Export', help: 'Export the DEM' },
  { name: 'export ortho',     dispatch: 'export-ortho',     needs: ['ortho'],     group: 'Export', help: 'Export the orthophoto' },
  { name: 'export cameras',   dispatch: 'export-cameras',   needs: ['poses'],     group: 'Export', help: 'Export camera poses' },
  { name: 'export sensors',   dispatch: 'export-sensors',   needs: ['sensors'],   group: 'Export', help: 'Export sensors' },
  { name: 'export keypoints', dispatch: 'export-keypoints', needs: ['keypoints'], group: 'Export', help: 'Export keypoints' },
  { name: 'export matches',   dispatch: 'export-matches',   needs: ['matches'],   group: 'Export', help: 'Export matches' },

  // --- App ---
  { name: 'project settings', aliases: ['project properties'], dispatch: 'open-project-settings', needs: ['project'], group: 'App', help: 'Open settings for the current project' },
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
  if ((cmd.needs ?? []).length)   lines.push(`  requires: ${cmd.needs.join(', ')}`)
  return lines
}

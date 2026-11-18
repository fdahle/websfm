// What a console line may be: its source, level and channel. The one table the console
// (DevConsole: badge colours, the source filter, its order) and the logging rules test
// (logRules.test.js) read. The rules themselves are in docs/conventions.md ▸ The console.
//
// A line is `log(message, level, source, { channel, command })` (composables/useLog.js),
// or `onLog(message, level, source)` from core and the workers.

// The sources, in pipeline order. A line's source is the area a user would look under
// for it, named as the ribbon names that area; a sub-step goes at the start of the
// message instead ("Mesh: …" under Products). `covers` says what belongs here, for the
// person adding a line; `color` is the badge's.
export const LOG_SOURCES = [
  { id: 'Project', color: '#2ecc71', covers: 'open, save, upgrade and storage of the project; project settings' },
  {
    id: 'Import',
    color: '#a0a03c',
    covers: 'reading a file another program wrote: clouds, meshes, rasters, COLMAP, Metashape, GCP and pose files',
  },
  { id: 'Images', color: '#4d9de0', covers: 'photos: adding, metadata, groups, masks, enabling, the image tools' },
  { id: 'Sensors', color: '#9b59b6', covers: 'sensors and their calibration, rigs, multispectral bands' },
  { id: 'Fiducials', color: '#8e6fd8', covers: 'film scans: fiducials, reseau crosses, panoramic strips' },
  { id: 'Poses', color: '#3cb4c8', covers: 'imported camera poses, EXIF positions, footprints' },
  { id: 'Detection', color: '#e67e22', covers: 'Detect Features: keypoints and descriptors' },
  { id: 'Matching', color: '#1abc9c', covers: 'Match Features: pair selection, matches, verification' },
  {
    id: 'Sparse',
    color: '#e0518a',
    covers: 'Sparse Model: registration, bundle adjustment, the region and orientation, Optimize Cameras',
  },
  {
    id: 'Georeferencing',
    color: '#d4a017',
    covers: 'GCPs, markers, checkpoints, scale bars, Find GCPs, georeferencing the model',
  },
  { id: 'Dense', color: '#c0504d', covers: 'depth maps and the dense cloud' },
  {
    id: 'Products',
    color: '#6fa84f',
    covers: 'DEM, orthophoto, mesh, texture, reflectance map, and the Tools that edit clouds, meshes and rasters',
  },
  { id: 'Evaluate', color: '#a67c52', covers: 'the Quality Report and the Evaluate tab' },
  { id: 'Export', color: '#5f9ea0', covers: 'writing files: every Export command, the project file' },
  { id: 'Workflow', color: '#7b8ce0', covers: 'the workflow runner: blocks, gates, pauses' },
  { id: 'Models', color: '#c77dba', covers: 'learned models: download, cache, files provided by hand' },
  { id: 'System', color: '#95a5a6', covers: 'the browser and machine: workers, GPU, memory budget, diagnostics' },
  { id: 'Viewer', color: '#48c9b0', covers: 'the 3D viewer and the map, when they cannot show something' },
  { id: 'Console', color: '#c0a020', covers: 'typed commands and their replies' },
]

export const LOG_SOURCE_IDS = LOG_SOURCES.map((s) => s.id)
const BY_ID = new Map(LOG_SOURCES.map((s) => [s.id, s]))

// Names earlier versions wrote, for lines saved in a project's log before the list
// was settled: shown and filtered under today's name.
export const LEGACY_SOURCES = {
  'Reconstruction': 'Sparse',
  'SfM': 'Sparse',
  'Compute': 'System',
  'Summary': 'System',
  'Pipeline': 'Workflow',
  'Sensor': 'Sensors',
  'Pose': 'Poses',
  'Footprint': 'Poses',
  'Fiducial': 'Fiducials',
  'GCP': 'Georeferencing',
  'Scale': 'Georeferencing',
  'Find GCPs': 'Georeferencing',
  'Metadata': 'Images',
}

/** Today's name for a source a line carries (a legacy name maps; unknown stays). */
export function logSourceId(source) {
  return source ? (LEGACY_SOURCES[source] ?? source) : source
}

/** The badge colour of a source, or a neutral grey for none or an unknown one. */
export function logSourceColor(source) {
  return BY_ID.get(logSourceId(source))?.color ?? '#888888'
}

// The levels, from quiet to loud. The console hides `debug` until Detail is on; the
// TXT export leaves it out unless asked.
export const LOG_LEVELS = {
  debug: 'internals for a bug report: a line per image, pair, tile or iteration, timings inside a stage, memory marks',
  info: "the record: what ran on what, the settings, each value chosen automatically with its inputs, a stage's result",
  success: 'the one closing line of an operation the user started that finished: its result, counts and time',
  warn: 'the run went on, but the user should know: a fallback, an input left out, a value clamped, a weak result',
  error: 'the operation, or a part the user asked for, failed: what failed, why, and what to do',
}
export const LOG_LEVEL_IDS = Object.keys(LOG_LEVELS)

// The channels, the console's tabs. `pipeline` is the record the export keeps;
// `activity` confirms an edit the user made by hand (and names the console command
// that makes it), shown live, left out of the export unless asked.
export const LOG_CHANNELS = ['pipeline', 'activity']

/** The source of a line about one product, by its kind: a sparse model's under Sparse … */
export function productLogSource(kind) {
  return kind === 'sparse' ? 'Sparse' : kind === 'dense' ? 'Dense' : 'Products'
}

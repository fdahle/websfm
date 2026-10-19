import {
  DETECT_SIFT_DEFAULTS, DETECT_SIFT_PRESETS, DETECT_DEFAULTS_BY_DETECTOR, DETECT_PRESETS_BY_DETECTOR,
  MATCH_DEFAULTS, MATCH_PRESETS, RECONSTRUCT_DEFAULTS, RECONSTRUCT_PRESETS,
  DEPTHMAP_DEFAULTS, DENSE_FUSE_DEFAULTS, DEM_DEFAULTS,
  ORTHO_DEFAULTS, MESH_DEFAULTS, MESH_PRESETS, TEXTURE_DEFAULTS,
  FILTER_CLOUD_DEFAULTS, FILTER_CLOUD_PRESETS, NORMALS_DEFAULTS, ICP_DEFAULTS,
  CLEAN_MESH_DEFAULTS, SMOOTH_MESH_DEFAULTS, DECIMATE_MESH_DEFAULTS,
} from './defaults.user.js'
import { DETECTOR_IDS } from './features/learnedDetectors.js'
import { initialMatchStrategy } from './recommend.js'
import {
  END_TARGET, GATE_FAIL_ACTIONS, GATE_METRIC_BY_ID, GATE_METRICS, GATE_OPS, gateDefaults,
} from './workflowGate.js'

export const WORKFLOW_VERSION = 3

const automated = (id, label, category, needs, produces, settings = {}, fields = []) => ({
  id, label, category, needs, produces, settings, fields, automated: true,
})
const interactive = (id, label, category, needs = [], opts = {}) => ({
  id, label, category, needs, produces: opts.produces ?? [], settings: {}, fields: [],
  automated: false, sceneType: opts.sceneType ?? null,
})
// A Tools-tab edit replayed as a block (the dense-edit pattern: one runEditClouds
// mode). It acts on the cloud or mesh the previous block of this run produced, else
// on Dense Model's cloud / Build Mesh's mesh, and adds a new derived one — so it has
// no reusable output and always runs.
const tool = (id, label, category, kind, mode, settings, fields) => ({
  ...automated(id, label, category, [kind === 'mesh' ? 'mesh' : 'dense'], [], settings, fields),
  tool: { kind, mode },
})
// Control blocks steer the run instead of computing anything (Quality Gate, Go to).
const control = (id, label, settings, fields) => ({
  ...automated(id, label, 'Control', [], [], settings, fields), control: true,
})

const PRESETS = ['low', 'medium', 'high', 'custom']

// One registry powers the builder palette, validation and executor. IDs deliberately
// equal the existing ribbon/console dispatch IDs so interactive blocks never invent a
// second command vocabulary.
export const WORKFLOW_BLOCKS = [
  interactive('auto-mask', 'Auto Mask', 'Preparation', ['images']),
  interactive('detect-fiducials', 'Detect Fiducials', 'Preparation', ['images']),
  interactive('calibrate-fiducials', 'Calibrate Fiducials', 'Preparation'),
  interactive('footprints-from-poses', 'Footprints from Poses', 'Preparation'),

  automated('detect-features', 'Detect Features', 'Features', ['images'], ['keypoints'],
    { detector: 'sift', preset: 'medium', overwrite: false, ...DETECT_SIFT_DEFAULTS }, [
      { key: 'detector', label: 'Detector', type: 'select', options: DETECTOR_IDS },
      { key: 'preset', label: 'Preset', type: 'select', options: PRESETS },
      { key: 'maxDim', label: 'Maximum dimension', type: 'number', min: 256 },
      { key: 'maxKeypoints', label: 'Maximum keypoints', type: 'number', min: 100 },
      { key: 'overwrite', label: 'Replace existing keypoints', type: 'boolean' },
    ]),
  automated('match-features', 'Match Features', 'Features', ['keypoints'], ['matches'],
    { strategy: 'auto', matcher: 'bruteforce', preset: 'medium', overwrite: false, ...MATCH_DEFAULTS }, [
      { key: 'strategy', label: 'Pairing', type: 'select', options: ['auto', 'exhaustive', 'sequential', 'preselect'] },
      { key: 'matcher', label: 'Matcher', type: 'select', options: ['bruteforce', 'lightglue'] },
      { key: 'preset', label: 'Preset', type: 'select', options: PRESETS },
      { key: 'sequentialOverlap', label: 'Sequential overlap', type: 'number', min: 1 },
      { key: 'overwrite', label: 'Replace existing matches', type: 'boolean' },
    ]),
  automated('reconstruct', 'Sparse Model', 'Sparse', ['matches'], ['sparse'],
    { preset: 'medium', ...RECONSTRUCT_DEFAULTS }, [
      { key: 'preset', label: 'Preset', type: 'select', options: PRESETS },
      { key: 'refineIntrinsics', label: 'Self-calibration', type: 'select', options: ['auto', 'none', 'f', 'f,cxcy', 'f,k1', 'f,cxcy,k1,k2,k3', 'f,cxcy,k1,k2,k3,k4'] },
      { key: 'baIterations', label: 'BA iterations', type: 'number', min: 1 },
    ]),
  // Between Sparse and Dense, as in the ribbon: a GCP adjustment invalidates
  // depth maps and everything after them.
  interactive('scale-bars', 'Scale Bars', 'Referencing', ['sparse']),
  interactive('georeference', 'Georeference', 'Referencing', ['sparse'], { sceneType: 'aerial' }),
  interactive('find-gcps', 'Find GCPs', 'Referencing', ['sparse'], { sceneType: 'aerial' }),

  automated('compute-depth', 'Depth Maps', 'Dense', ['sparse'], ['depthMaps'],
    { ...DEPTHMAP_DEFAULTS }, [
      { key: 'quality', label: 'Quality', type: 'select', options: ['low', 'medium', 'high', 'ultra'] },
      { key: 'maxSources', label: 'Source views', type: 'number', min: 1 },
      { key: 'geomConsistency', label: 'Geometric consistency', type: 'boolean' },
    ]),
  automated('dense', 'Dense Model', 'Dense', ['depthMaps'], ['dense'],
    { ...DENSE_FUSE_DEFAULTS }, [
      { key: 'auto', label: 'Automatic thresholds', type: 'boolean' },
      { key: 'minViews', label: 'Minimum views', type: 'number', min: 1 },
      { key: 'removeIsolated', label: 'Remove isolated points', type: 'boolean' },
    ]),

  automated('gen-dem', 'Build DEM', 'Products', ['cloud'], ['dem'], { ...DEM_DEFAULTS }, [
    { key: 'crs', label: 'Frame', type: 'select', options: ['local', 'project'] },
    { key: 'gsd', label: 'GSD (0 = auto)', type: 'number', min: 0 },
    { key: 'aggregate', label: 'Surface', type: 'select', options: ['max', 'mean', 'median'] },
  ]),
  automated('gen-ortho', 'Build Orthophoto', 'Products', ['surface', 'depthMaps'], ['ortho'],
    { ...ORTHO_DEFAULTS }, [
      { key: 'surface', label: 'Surface', type: 'select', options: ['dem', 'mesh', 'plane'] },
      { key: 'gsd', label: 'GSD (0 = auto)', type: 'number', min: 0 },
      { key: 'blend', label: 'Blending', type: 'select', options: ['mosaic', 'best', 'average'] },
      { key: 'seamline', label: 'Seamlines', type: 'select', options: ['graphcut', 'nadir'] },
      { key: 'seamBlend', label: 'Seam blending', type: 'select', options: ['multiband', 'feather'] },
    ]),
  automated('gen-mesh', 'Build Mesh', 'Products', ['dense'], ['mesh'], { preset: 'medium', ...MESH_DEFAULTS }, [
    { key: 'preset', label: 'Preset', type: 'select', options: PRESETS },
    { key: 'depth', label: 'Octree depth', type: 'number', min: 4, max: 12 },
    { key: 'trim', label: 'Surface trimming', type: 'select', options: ['off', 'gentle', 'strong'] },
    { key: 'fillHoles', label: 'Fill small holes', type: 'boolean' },
    { key: 'removeFloaters', label: 'Remove floating pieces', type: 'boolean' },
  ]),

  // Textures the newest computed mesh (Build Mesh's), optionally decimated first: a
  // few hundred thousand triangles texture as well as millions, and lighter.
  automated('texture-mesh', 'Texture Mesh', 'Products', ['mesh', 'sparse'], ['texturedMesh'],
    { decimateTo: 0, ...TEXTURE_DEFAULTS }, [
      { key: 'decimateTo', label: 'Decimate to (triangles, 0 = off)', type: 'number', min: 0 },
      { key: 'maxScale', label: 'Texture resolution', type: 'select', options: [1, 0.5, 0.25] },
      { key: 'pageSize', label: 'Page size', type: 'select', options: [2048, 4096, 8192] },
      { key: 'maxPages', label: 'Maximum pages', type: 'number', min: 1 },
      { key: 'levelColours', label: 'Level colours', type: 'boolean' },
      { key: 'unseen', label: 'Faces no photo sees', type: 'select', options: ['colour', 'remove'] },
    ]),

  interactive('eval-overview', 'Quality Report', 'Evaluation'),
  interactive('eval-match-graph', 'Evaluate Matching', 'Evaluation', ['matches']),
  interactive('eval-reconstruction', 'Evaluate Sparse Model', 'Evaluation', ['sparse']),
  interactive('eval-calibration', 'Evaluate Calibration', 'Evaluation', ['sparse']),
  interactive('eval-gcps', 'Evaluate Accuracy', 'Evaluation', ['sparse']),
  interactive('eval-coverage', 'Evaluate Coverage', 'Evaluation', ['sparse']),
  interactive('eval-depth-coverage', 'Evaluate Depth Coverage', 'Evaluation', ['depthMaps']),

  // Tools ▸ Point Cloud ▾. Crop and merge stay interactive: their boxes and source
  // lists are picked per project, not replayed.
  tool('filter-cloud', 'Filter Point Cloud', 'Post-processing', 'cloud', 'filter',
    { preset: 'medium', ...FILTER_CLOUD_DEFAULTS }, [
      { key: 'preset', label: 'Preset', type: 'select', options: ['light', 'medium', 'strong', 'custom'] },
      { key: 'methods', label: 'Methods (in run order)', type: 'multi', options: ['range', 'voxel', 'isolated', 'sor'] },
      { key: 'sorK', label: 'Outliers: neighbours', type: 'number', min: 2 },
      { key: 'sorStdRatio', label: 'Outliers: σ ratio', type: 'number', min: 0 },
      { key: 'voxelCell', label: 'Voxel size (0 = auto)', type: 'number', min: 0 },
      { key: 'isolatedCell', label: 'Isolated: cell (0 = auto)', type: 'number', min: 0 },
      { key: 'zMin', label: 'Range: minimum Z', type: 'number' },
      { key: 'zMax', label: 'Range: maximum Z', type: 'number' },
    ]),
  tool('estimate-normals', 'Estimate Normals', 'Post-processing', 'cloud', 'normals', { ...NORMALS_DEFAULTS }, [
    { key: 'k', label: 'Neighbours', type: 'number', min: 3 },
    { key: 'orient', label: 'Orient', type: 'select', options: ['auto', 'cameras', 'up', 'existing'] },
  ]),
  tool('align-icp', 'Align to Reference (ICP)', 'Post-processing', 'cloud', 'icp', { reference: '', ...ICP_DEFAULTS }, [
    { key: 'reference', label: 'Reference (cloud or mesh name)', type: 'text' },
    { key: 'maxIterations', label: 'Iterations', type: 'number', min: 1, max: 200 },
    { key: 'maxDistance', label: 'Search radius (0 = auto)', type: 'number', min: 0 },
    { key: 'sampleCount', label: 'Sample points', type: 'number', min: 1000 },
    { key: 'pointToPlane', label: 'Point-to-plane', type: 'boolean' },
    { key: 'estimateScale', label: 'Estimate scale', type: 'boolean' },
  ]),
  interactive('crop-cloud', 'Crop Point Cloud', 'Post-processing', ['dense']),
  interactive('merge-clouds', 'Merge Point Clouds', 'Post-processing', ['dense']),

  // Tools ▸ Mesh ▾.
  tool('clean-mesh', 'Clean Mesh', 'Mesh tools', 'mesh', 'mesh-clean', { ...CLEAN_MESH_DEFAULTS }, [
    { key: 'methods', label: 'Steps', type: 'multi', options: ['weld', 'components', 'longEdges', 'holes', 'compact'] },
    { key: 'minFraction', label: 'Smallest piece (share of largest)', type: 'number', min: 0, max: 1 },
    { key: 'minTriangles', label: 'Smallest piece (triangles)', type: 'number', min: 0 },
    { key: 'maxEdgeFactor', label: 'Long edge (× median)', type: 'number', min: 1 },
    { key: 'maxHoleEdges', label: 'Largest hole (edges, 0 = all)', type: 'number', min: 0 },
  ]),
  tool('smooth-mesh', 'Smooth Mesh', 'Mesh tools', 'mesh', 'mesh-smooth', { ...SMOOTH_MESH_DEFAULTS }, [
    { key: 'iterations', label: 'Iterations', type: 'number', min: 1 },
    { key: 'lambda', label: 'λ (smooth)', type: 'number', min: 0 },
    { key: 'mu', label: 'μ (inflate)', type: 'number', max: 0 },
    { key: 'fixBoundary', label: 'Keep the boundary fixed', type: 'boolean' },
  ]),
  tool('decimate-mesh', 'Decimate Mesh', 'Mesh tools', 'mesh', 'mesh-decimate', { ...DECIMATE_MESH_DEFAULTS }, [
    { key: 'targetMode', label: 'Reduce to', type: 'select', options: ['ratio', 'count'] },
    { key: 'targetRatio', label: 'Share of triangles', type: 'number', min: 0, max: 1 },
    { key: 'targetTriangles', label: 'Triangle count', type: 'number', min: 4 },
    { key: 'preserveBoundary', label: 'Preserve the boundary', type: 'boolean' },
  ]),

  control('gate', 'Quality Gate',
    { ...gateDefaults('registeredPct'), onFail: 'pause', failTarget: '', passTarget: '' }, [
      { key: 'metric', label: 'Metric', type: 'select', help: true,
        options: GATE_METRICS.map((m) => ({ value: m.id, label: m.unit ? `${m.label} (${m.unit})` : m.label })) },
      { key: 'op', label: 'Passes when', type: 'select', options: GATE_OPS, help: true },
      { key: 'threshold', label: 'Threshold', type: 'number', help: true },
      { key: 'onFail', label: 'If it fails', type: 'select', help: true, options: [
        { value: 'pause', label: 'Pause and ask' }, { value: 'stop', label: 'Stop the workflow' },
        { value: 'continue', label: 'Continue (record only)' }, { value: 'branch', label: 'Go to a block' },
      ] },
      { key: 'failTarget', label: 'On fail, go to', type: 'target', help: true, when: (s) => s.onFail === 'branch' },
      { key: 'passTarget', label: 'On pass, go to', type: 'target', help: true },
    ]),
  control('goto', 'Go to', { target: '' }, [
    { key: 'target', label: 'Go to', type: 'target', help: true },
  ]),
]

export const WORKFLOW_BLOCK_BY_ID = new Map(WORKFLOW_BLOCKS.map((b) => [b.id, b]))
export const WORKFLOW_CATEGORIES = [...new Set(WORKFLOW_BLOCKS.map((b) => b.category))]

// Blocks that read image pixels, so a run containing one first checks that every
// image's file can still be read (useImagesStore.probeImageSources).
export const PIXEL_BLOCKS = new Set([
  'auto-mask', 'detect-fiducials', 'detect-features', 'compute-depth', 'dense', 'gen-ortho', 'texture-mesh',
])

// The settings keys a block type accepts: its defaults, its fields, every detector's
// schema (a detector switch swaps them) and every preset delta. Normalisation keeps
// exactly these, so the recipe text can reject anything else instead of dropping it.
const PRESET_TABLES = {
  'match-features': [MATCH_PRESETS], reconstruct: [RECONSTRUCT_PRESETS], 'gen-mesh': [MESH_PRESETS],
  'filter-cloud': [FILTER_CLOUD_PRESETS], 'detect-features': Object.values(DETECT_PRESETS_BY_DETECTOR),
}
const SETTING_KEYS = new Map(WORKFLOW_BLOCKS.map((spec) => {
  const keys = new Set([...Object.keys(spec.settings), ...spec.fields.map((f) => f.key)])
  if (spec.id === 'detect-features') {
    for (const d of Object.values(DETECT_DEFAULTS_BY_DETECTOR)) for (const k of Object.keys(d)) keys.add(k)
  }
  for (const table of PRESET_TABLES[spec.id] ?? []) {
    for (const delta of Object.values(table)) for (const k of Object.keys(delta)) keys.add(k)
  }
  return [spec.id, keys]
}))
export function workflowSettingKeys(type) {
  return SETTING_KEYS.get(type) ?? new Set()
}

// Block names: what gates and Go to blocks jump to. A token so the recipe text can
// carry them; `end` is the reserved "finish the workflow" target.
export const BLOCK_NAME_RE = /^[A-Za-z_][A-Za-z0-9_-]*$/
export const REUSE_POLICIES = ['inherit', 'valid', 'ask', 'rerun']
export const WARNING_POLICIES = ['inherit', 'pause', 'continue', 'stop']
export const DISPLAY_LEVELS = ['guided', 'standard', 'expert']

export function createWorkflow(name = 'Untitled workflow', blocks = []) {
  return {
    version: WORKFLOW_VERSION,
    id: makeId('workflow'),
    name,
    displayLevel: 'standard',
    defaults: { warningPolicy: 'pause', reusePolicy: 'valid' },
    blocks: blocks.map((type) => createWorkflowBlock(type)),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  }
}

export function createWorkflowBlock(type, name = '') {
  const spec = WORKFLOW_BLOCK_BY_ID.get(type)
  if (!spec) throw new Error(`Unknown workflow block: ${type}`)
  return {
    id: makeId('block'), type, name, enabled: true,
    settings: structuredCopy(spec.settings), reusePolicy: 'inherit', warningPolicy: 'inherit',
  }
}

export function normalizeWorkflow(value) {
  const src = value && typeof value === 'object' ? value : {}
  const rawBlocks = Array.isArray(src.blocks) ? src.blocks : []
  const blocks = rawBlocks.flatMap((block) => {
    const spec = WORKFLOW_BLOCK_BY_ID.get(block?.type)
    if (!spec) return []
    const keys = workflowSettingKeys(block.type)
    const settings = structuredCopy(spec.settings)
    for (const [key, v] of Object.entries(block.settings || {})) {
      // Unset (null) is the same as absent for a key without a default.
      if (!keys.has(key) || v === undefined || (v === null && !(key in settings))) continue
      // A non-finite number cannot survive JSON (it would read back as null).
      settings[key] = typeof v === 'number' && !Number.isFinite(v) ? null : v
    }
    return [{
      id: String(block.id || makeId('block')), type: block.type,
      name: typeof block.name === 'string' ? block.name : '',
      enabled: block.enabled !== false,
      settings,
      reusePolicy: REUSE_POLICIES.includes(block.reusePolicy) ? block.reusePolicy : 'inherit',
      warningPolicy: WARNING_POLICIES.includes(block.warningPolicy) ? block.warningPolicy : 'inherit',
    }]
  })
  return {
    version: WORKFLOW_VERSION,
    id: String(src.id || makeId('workflow')),
    name: String(src.name || 'Untitled workflow'),
    displayLevel: DISPLAY_LEVELS.includes(src.displayLevel) ? src.displayLevel : 'standard',
    defaults: {
      warningPolicy: ['pause', 'continue', 'stop'].includes(src.defaults?.warningPolicy) ? src.defaults.warningPolicy : 'pause',
      reusePolicy: ['valid', 'ask', 'rerun'].includes(src.defaults?.reusePolicy) ? src.defaults.reusePolicy : 'valid',
    },
    blocks,
    createdAt: src.createdAt || new Date().toISOString(),
    updatedAt: src.updatedAt || new Date().toISOString(),
  }
}

// ── Control flow ─────────────────────────────────────────────────────────────
// A workflow runs top to bottom; a Quality Gate or Go to block may jump FORWARD to a
// named block, or to `end`. Backward jumps are refused: every stage is deterministic,
// so re-running the same blocks with the same settings measures the same value
// again. A retry is written as a forward branch to a copy of the stage with other
// settings, which also guarantees every run terminates (the block index only grows).

// The blocks a jump may target from `index`: the named-or-not blocks after it.
export function blockJumpTargets(workflow, index) {
  return workflow.blocks.map((block, i) => ({ block, index: i })).filter((x) => x.index > index)
}

// The outgoing jump targets a control block's settings name ('' = none).
export function blockTargets(block) {
  if (block.type === 'gate') {
    return [
      ...(block.settings.onFail === 'branch' ? [{ role: 'fail', key: 'failTarget', target: block.settings.failTarget }] : []),
      ...(block.settings.passTarget ? [{ role: 'pass', key: 'passTarget', target: block.settings.passTarget }] : []),
    ]
  }
  if (block.type === 'goto') return [{ role: 'goto', key: 'target', target: block.settings.target }]
  return []
}

// Where execution continues after `index` given a target name: the target block's
// position (`blocks.length` for `end`), or -1 when no block has that name.
export function workflowTargetIndex(workflow, target) {
  if (target === END_TARGET) return workflow.blocks.length
  return workflow.blocks.findIndex((b) => b.name && b.name === target)
}

// A fresh name for a block that is about to become a jump target: its type and a
// number, unique in the workflow.
export function suggestBlockName(workflow, type) {
  const taken = new Set(workflow.blocks.map((b) => b.name).filter(Boolean))
  for (let n = 1; ; n++) {
    const name = `${type}-${n}`
    if (!taken.has(name)) return name
  }
}

// Rename a block and every jump that points at it. → the new blocks array.
export function renameWorkflowBlock(workflow, id, name) {
  const old = workflow.blocks.find((b) => b.id === id)?.name
  return workflow.blocks.map((b) => {
    let next = b.id === id ? { ...b, name } : b
    if (old) {
      for (const { key, target } of blockTargets(b)) {
        if (target === old) next = { ...next, settings: { ...next.settings, [key]: name } }
      }
    }
    return next
  })
}

const addOutputs = (available, spec) => {
  for (const output of spec.produces) available.add(output)
  if (spec.produces.includes('dense')) available.add('cloud')
  if (spec.produces.includes('mesh')) available.add('surface')
  if (spec.produces.includes('dem')) available.add('surface')
}
const missingNeeds = (needs, available) => needs.filter((need) => need === 'surface'
  ? !(available.has('dem') || available.has('mesh') || available.has('cloud'))
  : !available.has(need))

// Preflight over the run's control-flow graph. Outputs are available at a block only
// if EVERY path that reaches it produced them (or the project already has them), so
// a stage behind a branch that may be skipped is caught here, not mid-run.
// `fromIndex` / `onlyIds` describe a partial run (Run from selected / Run selected).
export function workflowPreflight(workflow, initial = {}, { fromIndex = 0, onlyIds = null } = {}) {
  const blocks = workflow.blocks
  const n = blocks.length
  const items = []
  const label = (b) => `${WORKFLOW_BLOCK_BY_ID.get(b.type)?.label ?? b.type}${b.name ? ` (${b.name})` : ''}`
  const active = blocks.map((b, i) => b.enabled && i >= fromIndex && (!onlyIds || onlyIds.has(b.id))
    && WORKFLOW_BLOCK_BY_ID.has(b.type))
  const nextActive = (i) => { while (i < n && !active[i]) i++; return i }

  const names = new Map()
  blocks.forEach((b, i) => {
    if (!b.name) return
    if (!BLOCK_NAME_RE.test(b.name) || b.name === END_TARGET) {
      items.push({ level: 'error', blockId: b.id, message: `${label(b)}: “${b.name}” is not a usable name (letters, digits, - and _; not “end”)` })
    } else if (names.has(b.name)) {
      items.push({ level: 'error', blockId: b.id, message: `${label(b)}: another block is already named “${b.name}”` })
    } else names.set(b.name, i)
  })

  // Successors of an active block; problems with its jumps are reported once here.
  const successors = blocks.map((b, i) => {
    if (!active[i]) return []
    const spec = WORKFLOW_BLOCK_BY_ID.get(b.type)
    const next = nextActive(i + 1)
    if (!spec.control) return [next]
    const jump = (target, what) => {
      if (!target) {
        items.push({ level: 'error', blockId: b.id, message: `${label(b)}: choose where “${what}” goes` })
        return null
      }
      if (target === END_TARGET) return n
      const t = names.get(target)
      if (t == null) {
        items.push({ level: 'error', blockId: b.id, message: `${label(b)}: no block is named “${target}”` })
        return null
      }
      if (t <= i) {
        items.push({ level: 'error', blockId: b.id, message: `${label(b)}: “${target}” is not below this block — jumps only go forward (add a copy of the stage below instead of looping)` })
        return null
      }
      if (!blocks[t].enabled) items.push({ level: 'info', blockId: b.id, message: `${label(b)}: “${target}” is disabled, so the jump continues at the next enabled block` })
      return nextActive(t)
    }
    if (b.type === 'goto') return [jump(b.settings.target, 'Go to')].filter((x) => x != null)
    const s = b.settings
    const out = [s.passTarget ? jump(s.passTarget, 'On pass, go to') : next]
    if (s.onFail === 'branch') out.push(jump(s.failTarget, 'On fail, go to'))
    else if (s.onFail !== 'stop') out.push(next)
    return out.filter((x) => x != null)
  })

  const entry = nextActive(fromIndex)
  const reach = new Array(n).fill(null)
  if (entry < n) {
    reach[entry] = new Set(Object.entries(initial).filter(([, v]) => !!v).map(([k]) => k))
  }
  for (let i = 0; i < n; i++) {
    if (!active[i]) continue
    const block = blocks[i]
    const spec = WORKFLOW_BLOCK_BY_ID.get(block.type)
    const available = reach[i]
    if (!available) {
      items.push({ level: 'warning', blockId: block.id, message: `${label(block)}: never runs — no path reaches it` })
      continue
    }
    const missing = missingNeeds(spec.needs, available)
    if (missing.length) items.push({ level: 'error', blockId: block.id, message: `${spec.label}: requires ${missing.join(', ')}` })
    if (spec.sceneType && initial.sceneType && spec.sceneType !== initial.sceneType) {
      items.push({ level: 'warning', blockId: block.id, message: `${spec.label}: intended for ${spec.sceneType} projects` })
    }
    if (!spec.automated) items.push({ level: 'info', blockId: block.id, message: `${spec.label}: pauses for user interaction` })
    if (block.type === 'gate') items.push(...gateProblems(block, available, label(block)))
    if (block.type === 'align-icp' && !String(block.settings.reference ?? '').trim()) {
      items.push({ level: 'error', blockId: block.id, message: `${spec.label}: name the reference cloud or mesh` })
    }
    const out = new Set(available)
    addOutputs(out, spec)
    for (const s of successors[i]) {
      if (s >= n) continue
      reach[s] = reach[s] ? new Set([...reach[s]].filter((k) => out.has(k))) : new Set(out)
    }
  }
  return items
}

function gateProblems(block, available, label) {
  const s = block.settings
  const metric = GATE_METRIC_BY_ID.get(s.metric)
  const items = []
  const error = (message) => items.push({ level: 'error', blockId: block.id, message: `${label}: ${message}` })
  if (!metric) error(`unknown metric “${s.metric}”`)
  else if (!available.has(metric.needs)) error(`${metric.label} is measured on ${metric.needs}, which no earlier block produces on every path here`)
  if (!GATE_OPS.includes(s.op)) error(`unknown comparison “${s.op}”`)
  if (typeof s.threshold !== 'number' || !Number.isFinite(s.threshold)) error('set a threshold')
  if (!GATE_FAIL_ACTIONS.includes(s.onFail)) error(`unknown failure action “${s.onFail}”`)
  return items
}

export function blockOutputValid(type, state = {}) {
  const spec = WORKFLOW_BLOCK_BY_ID.get(type)
  return !!spec?.produces?.length && spec.produces.every((key) => key === 'surface'
    ? !!(state.dem || state.mesh || state.cloud)
    : !!state[key])
}

// Modal-equivalent settings resolution for blocks executed without opening their
// modal. Preset deltas are applied last; editing an individual preset-controlled
// field makes the builder mark the block `custom`.
export function resolveWorkflowSettings(type, settings = {}, runtime = {}) {
  const value = { ...settings }
  if (type === 'detect-features') {
    const base = DETECT_DEFAULTS_BY_DETECTOR[value.detector] ?? DETECT_SIFT_DEFAULTS
    const presets = DETECT_PRESETS_BY_DETECTOR[value.detector] ?? DETECT_SIFT_PRESETS
    return { ...base, ...value, ...(presets[value.preset] || {}), useGpu: runtime.useGpu, memBudgetBytes: runtime.memBudgetBytes }
  }
  if (type === 'match-features') {
    // 'auto' pairing is what the Match Features dialog opens on for this project:
    // Preselect with camera positions, Sequential for video frames, else Exhaustive.
    // A workflow is a template, so it is decided per run, not when the block was added.
    const strategy = value.strategy === 'auto' || value.strategy == null
      ? initialMatchStrategy(runtime.posedImageCount ?? 0, { video: !!runtime.video })
      : value.strategy
    return { ...MATCH_DEFAULTS, ...value, ...(MATCH_PRESETS[value.preset] || {}), strategy, useGpu: runtime.useGpu }
  }
  if (type === 'reconstruct') return { ...RECONSTRUCT_DEFAULTS, ...value, ...(RECONSTRUCT_PRESETS[value.preset] || {}) }
  if (type === 'compute-depth') {
    const { filterRelTol, maxDim, bestK, ...rest } = { ...DEPTHMAP_DEFAULTS, ...value }
    return {
      ...rest, filterRelTol: filterRelTol / 100, useGpu: runtime.useGpu,
      memBudgetBytes: runtime.memBudgetBytes,
      ...(maxDim > 0 ? { maxDim } : {}), ...(bestK > 0 ? { bestK } : {}),
    }
  }
  if (type === 'dense') {
    const v = { ...DENSE_FUSE_DEFAULTS, ...value }
    return {
      minViews: v.auto ? null : v.minViews, maxCost: v.auto ? null : v.maxCost,
      depthTolRel: v.depthTolPct / 100, step: v.step, minTriAngleDeg: v.minTriAngleDeg,
      maxIncidenceDeg: v.maxIncidenceDeg, removeIsolated: v.removeIsolated,
      memBudgetBytes: runtime.memBudgetBytes,
    }
  }
  if (type === 'gen-dem') {
    const { gsd, ...rest } = { ...DEM_DEFAULTS, ...value, memBudgetBytes: runtime.memBudgetBytes }
    return gsd > 0 ? { ...rest, gsd } : rest
  }
  if (type === 'gen-ortho') {
    const v = { ...ORTHO_DEFAULTS, ...value }
    return { ...v, gsd: v.gsd > 0 ? v.gsd : 0, depthTolRel: v.depthTolRel / 100, maxCost: v.maxCost > 0 ? v.maxCost : Infinity,
      memBudgetBytes: runtime.memBudgetBytes }
  }
  if (type === 'gen-mesh') return { ...MESH_DEFAULTS, ...value, ...(MESH_PRESETS[value.preset] || {}) }
  if (type === 'texture-mesh') {
    const { decimateTo, ...rest } = { ...TEXTURE_DEFAULTS, ...value }
    return { ...rest, maxScale: Number(rest.maxScale), pageSize: Number(rest.pageSize), decimateTo: Math.max(0, Math.round(decimateTo || 0)),
      useGpu: runtime.useGpu, memBudgetBytes: runtime.memBudgetBytes }
  }
  // The tool blocks build the same request settings their dialogs emit.
  if (type === 'filter-cloud') {
    const s = { ...FILTER_CLOUD_DEFAULTS, ...value, ...(FILTER_CLOUD_PRESETS[value.preset] || {}) }
    const nz = (v) => (v != null && Number.isFinite(Number(v)) ? Number(v) : null)
    return {
      methods: [...s.methods],
      sor: { k: s.sorK, stdRatio: s.sorStdRatio },
      voxel: { cell: s.voxelCell > 0 ? s.voxelCell : (runtime.mergeCell ?? 0) },
      isolated: { cell: s.isolatedCell, minNeighbors: s.isolatedMinNeighbors, maxSupport: s.isolatedMaxSupport },
      range: { zMin: nz(s.zMin), zMax: nz(s.zMax), lumaMin: nz(s.lumaMin), lumaMax: nz(s.lumaMax) },
    }
  }
  if (type === 'estimate-normals') {
    const s = { ...NORMALS_DEFAULTS, ...value }
    return { k: s.k, orient: s.orient }
  }
  if (type === 'align-icp') {
    const s = { ...ICP_DEFAULTS, ...value }
    return {
      reference: String(s.reference ?? '').trim(),
      maxIterations: s.maxIterations, maxDistance: s.maxDistance > 0 ? s.maxDistance : 0,
      sampleCount: s.sampleCount, pointToPlane: !!s.pointToPlane, estimateScale: !!s.estimateScale,
    }
  }
  if (type === 'clean-mesh') {
    const s = { ...CLEAN_MESH_DEFAULTS, ...value }
    return {
      methods: [...s.methods], minTriangles: s.minTriangles, minFraction: s.minFraction,
      maxEdgeFactor: s.maxEdgeFactor, maxHoleEdges: s.maxHoleEdges > 0 ? s.maxHoleEdges : 0,
    }
  }
  if (type === 'smooth-mesh') {
    const s = { ...SMOOTH_MESH_DEFAULTS, ...value }
    return { iterations: s.iterations, lambda: s.lambda, mu: s.mu, fixBoundary: !!s.fixBoundary }
  }
  if (type === 'decimate-mesh') {
    const s = { ...DECIMATE_MESH_DEFAULTS, ...value }
    return s.targetMode === 'count'
      ? { targetTriangles: Math.round(s.targetTriangles), preserveBoundary: !!s.preserveBoundary }
      : { targetRatio: s.targetRatio, preserveBoundary: !!s.preserveBoundary }
  }
  return value
}

// Apply one builder edit while keeping detector-specific defaults coherent. A
// detector switch is a schema switch, not an ordinary custom-field edit: carrying
// SIFT's 10k keypoint budget into a learned detector defeats its deliberately low O(N²)
// LightGlue ceiling. Keep the selected named preset where possible; a custom set
// has no meaningful cross-detector equivalent, so reset it to the safe default.
export function updateWorkflowSetting(settings = {}, key, value) {
  if (key === 'detector' && DETECT_DEFAULTS_BY_DETECTOR[value]) {
    const preset = ['low', 'medium', 'high'].includes(settings.preset) ? settings.preset : 'medium'
    const base = DETECT_DEFAULTS_BY_DETECTOR[value]
    const presets = DETECT_PRESETS_BY_DETECTOR[value]
    return {
      detector: value,
      preset,
      overwrite: settings.overwrite ?? false,
      ...base,
      ...(presets[preset] || {}),
    }
  }
  // A gate's comparison belongs to its metric: a px bound means nothing as a share.
  if (key === 'metric' && GATE_METRIC_BY_ID.has(value)) return { ...settings, ...gateDefaults(value) }
  const next = { ...settings, [key]: value }
  if (key !== 'preset' && 'preset' in next) next.preset = 'custom'
  return next
}

function makeId(prefix) {
  return `${prefix}-${globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`}`
}
function structuredCopy(value) {
  return value == null ? value : JSON.parse(JSON.stringify(value))
}

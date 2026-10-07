import {
  DETECT_SIFT_DEFAULTS, DETECT_SIFT_PRESETS, DETECT_SUPERPOINT_DEFAULTS, DETECT_SUPERPOINT_PRESETS,
  MATCH_DEFAULTS, MATCH_PRESETS, RECONSTRUCT_DEFAULTS, RECONSTRUCT_PRESETS,
  DEPTHMAP_DEFAULTS, DENSE_FUSE_DEFAULTS, DEM_DEFAULTS,
  ORTHO_DEFAULTS, MESH_DEFAULTS, MESH_PRESETS,
} from './defaults.user.js'

export const WORKFLOW_VERSION = 2

const automated = (id, label, category, needs, produces, settings = {}, fields = []) => ({
  id, label, category, needs, produces, settings, fields, automated: true,
})
const interactive = (id, label, category, needs = [], opts = {}) => ({
  id, label, category, needs, produces: opts.produces ?? [], settings: {}, fields: [],
  automated: false, sceneType: opts.sceneType ?? null,
})

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
      { key: 'detector', label: 'Detector', type: 'select', options: ['sift', 'superpoint'] },
      { key: 'preset', label: 'Preset', type: 'select', options: ['low', 'medium', 'high', 'custom'] },
      { key: 'maxDim', label: 'Maximum dimension', type: 'number', min: 256 },
      { key: 'maxKeypoints', label: 'Maximum keypoints', type: 'number', min: 100 },
      { key: 'overwrite', label: 'Replace existing keypoints', type: 'boolean' },
    ]),
  automated('match-features', 'Match Features', 'Features', ['keypoints'], ['matches'],
    { strategy: 'exhaustive', matcher: 'bruteforce', preset: 'medium', overwrite: false, ...MATCH_DEFAULTS }, [
      { key: 'strategy', label: 'Pairing', type: 'select', options: ['exhaustive', 'sequential', 'preselect'] },
      { key: 'matcher', label: 'Matcher', type: 'select', options: ['bruteforce', 'lightglue'] },
      { key: 'preset', label: 'Preset', type: 'select', options: ['low', 'medium', 'high', 'custom'] },
      { key: 'sequentialOverlap', label: 'Sequential overlap', type: 'number', min: 1 },
      { key: 'overwrite', label: 'Replace existing matches', type: 'boolean' },
    ]),
  automated('reconstruct', 'Sparse Model', 'Reconstruction', ['matches'], ['sparse'],
    { preset: 'medium', ...RECONSTRUCT_DEFAULTS }, [
      { key: 'preset', label: 'Preset', type: 'select', options: ['low', 'medium', 'high', 'custom'] },
      { key: 'refineIntrinsics', label: 'Self-calibration', type: 'select', options: ['auto', 'none', 'f', 'f,cxcy', 'f,k1'] },
      { key: 'baIterations', label: 'BA iterations', type: 'number', min: 1 },
    ]),
  automated('compute-depth', 'Depth Maps', 'Reconstruction', ['sparse'], ['depthMaps'],
    { ...DEPTHMAP_DEFAULTS }, [
      { key: 'quality', label: 'Quality', type: 'select', options: ['low', 'medium', 'high', 'ultra'] },
      { key: 'maxSources', label: 'Source views', type: 'number', min: 1 },
      { key: 'geomConsistency', label: 'Geometric consistency', type: 'boolean' },
    ]),
  automated('dense', 'Dense Model', 'Reconstruction', ['depthMaps'], ['dense'],
    { ...DENSE_FUSE_DEFAULTS }, [
      { key: 'auto', label: 'Automatic thresholds', type: 'boolean' },
      { key: 'minViews', label: 'Minimum views', type: 'number', min: 1 },
      { key: 'removeIsolated', label: 'Remove isolated points', type: 'boolean' },
    ]),

  interactive('scale-bars', 'Scale Bars', 'Referencing', ['sparse']),
  interactive('georeference', 'Georeference', 'Referencing', ['sparse'], { sceneType: 'aerial' }),
  interactive('find-gcps', 'Find GCPs', 'Referencing', ['sparse'], { sceneType: 'aerial' }),

  automated('gen-dem', 'Build DEM', 'Products', ['cloud'], ['dem'], { ...DEM_DEFAULTS }, [
    { key: 'crs', label: 'Frame', type: 'select', options: ['local', 'project'] },
    { key: 'gsd', label: 'GSD (0 = auto)', type: 'number', min: 0 },
    { key: 'aggregate', label: 'Surface', type: 'select', options: ['max', 'mean', 'median'] },
  ]),
  automated('gen-ortho', 'Build Orthophoto', 'Products', ['surface', 'depthMaps'], ['ortho'],
    { ...ORTHO_DEFAULTS }, [
      { key: 'surface', label: 'Surface', type: 'select', options: ['dem', 'mesh', 'plane'] },
      { key: 'gsd', label: 'GSD (0 = auto)', type: 'number', min: 0 },
      { key: 'blend', label: 'Blending', type: 'select', options: ['best', 'average'] },
    ]),
  automated('gen-mesh', 'Build Mesh', 'Products', ['dense'], ['mesh'], { preset: 'medium', ...MESH_DEFAULTS }, [
    { key: 'preset', label: 'Preset', type: 'select', options: ['low', 'medium', 'high', 'custom'] },
    { key: 'depth', label: 'Octree depth', type: 'number', min: 4, max: 12 },
    { key: 'trim', label: 'Surface trimming', type: 'select', options: ['off', 'gentle', 'strong'] },
    { key: 'fillHoles', label: 'Fill small holes', type: 'boolean' },
    { key: 'removeFloaters', label: 'Remove floating pieces', type: 'boolean' },
  ]),

  interactive('eval-overview', 'Quality Report', 'Evaluation'),
  interactive('eval-match-graph', 'Evaluate Matching', 'Evaluation', ['matches']),
  interactive('eval-reconstruction', 'Evaluate Sparse Model', 'Evaluation', ['sparse']),
  interactive('eval-calibration', 'Evaluate Calibration', 'Evaluation', ['sparse']),
  interactive('eval-gcps', 'Evaluate Accuracy', 'Evaluation', ['sparse']),
  interactive('eval-coverage', 'Evaluate Coverage', 'Evaluation', ['sparse']),
  interactive('eval-depth-coverage', 'Evaluate Depth Coverage', 'Evaluation', ['depthMaps']),
  interactive('filter-cloud', 'Filter Point Cloud', 'Post-processing', ['dense']),
  interactive('crop-cloud', 'Crop Point Cloud', 'Post-processing', ['dense']),
  interactive('merge-clouds', 'Merge Point Clouds', 'Post-processing', ['dense']),
]

export const WORKFLOW_BLOCK_BY_ID = new Map(WORKFLOW_BLOCKS.map((b) => [b.id, b]))
export const WORKFLOW_CATEGORIES = [...new Set(WORKFLOW_BLOCKS.map((b) => b.category))]

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

export function createWorkflowBlock(type) {
  const spec = WORKFLOW_BLOCK_BY_ID.get(type)
  if (!spec) throw new Error(`Unknown workflow block: ${type}`)
  return {
    id: makeId('block'), type, enabled: true,
    settings: structuredCopy(spec.settings), reusePolicy: 'inherit', warningPolicy: 'inherit',
  }
}

export function normalizeWorkflow(value) {
  const src = value && typeof value === 'object' ? value : {}
  const rawBlocks = Array.isArray(src.blocks) ? src.blocks : []
  // Version 1 silently created one of these scene-specific starters. They were
  // never a user choice, so migrate only the exact untouched starter to the new
  // empty canvas. Any edited or renamed workflow is preserved.
  const legacyTypes = rawBlocks.map((block) => block?.type).join(',')
  const isLegacyStarter = src.version === 1 && (
    (src.name === 'Aerial DEM + orthophoto' && legacyTypes === 'detect-features,match-features,reconstruct,compute-depth,dense,gen-dem,gen-ortho')
    || (src.name === 'Object model + mesh' && legacyTypes === 'detect-features,match-features,reconstruct,compute-depth,dense,gen-mesh')
  )
  const blocks = (isLegacyStarter ? [] : rawBlocks).flatMap((block) => {
    const spec = WORKFLOW_BLOCK_BY_ID.get(block?.type)
    if (!spec) return []
    return [{
      id: String(block.id || makeId('block')), type: block.type, enabled: block.enabled !== false,
      settings: { ...structuredCopy(spec.settings), ...(block.settings || {}) },
      reusePolicy: ['inherit', 'valid', 'ask', 'rerun'].includes(block.reusePolicy) ? block.reusePolicy : 'inherit',
      warningPolicy: ['inherit', 'pause', 'continue', 'stop'].includes(block.warningPolicy) ? block.warningPolicy : 'inherit',
    }]
  })
  return {
    version: WORKFLOW_VERSION,
    id: String(src.id || makeId('workflow')),
    name: isLegacyStarter ? 'Untitled workflow' : String(src.name || 'Untitled workflow'),
    displayLevel: ['guided', 'standard', 'expert'].includes(src.displayLevel) ? src.displayLevel : 'standard',
    defaults: {
      warningPolicy: ['pause', 'continue', 'stop'].includes(src.defaults?.warningPolicy) ? src.defaults.warningPolicy : 'pause',
      reusePolicy: ['valid', 'ask', 'rerun'].includes(src.defaults?.reusePolicy) ? src.defaults.reusePolicy : 'valid',
    },
    blocks,
    createdAt: src.createdAt || new Date().toISOString(),
    updatedAt: src.updatedAt || new Date().toISOString(),
  }
}

export function workflowPreflight(workflow, initial = {}) {
  const available = new Set(Object.entries(initial).filter(([, v]) => !!v).map(([k]) => k))
  const items = []
  for (const block of workflow.blocks.filter((b) => b.enabled)) {
    const spec = WORKFLOW_BLOCK_BY_ID.get(block.type)
    const missing = spec.needs.filter((need) => need === 'surface'
      ? !(available.has('dem') || available.has('mesh') || available.has('cloud'))
      : !available.has(need))
    if (missing.length) items.push({ level: 'error', blockId: block.id, message: `${spec.label}: requires ${missing.join(', ')}` })
    if (spec.sceneType && initial.sceneType && spec.sceneType !== initial.sceneType) {
      items.push({ level: 'warning', blockId: block.id, message: `${spec.label}: intended for ${spec.sceneType} projects` })
    }
    if (!spec.automated) items.push({ level: 'info', blockId: block.id, message: `${spec.label}: pauses for user interaction` })
    for (const output of spec.produces) available.add(output)
    if (spec.produces.includes('dense')) available.add('cloud')
    if (spec.produces.includes('mesh')) available.add('surface')
    if (spec.produces.includes('dem')) available.add('surface')
  }
  return items
}

export function blockOutputValid(type, state = {}) {
  const spec = WORKFLOW_BLOCK_BY_ID.get(type)
  return !!spec?.produces?.length && spec.produces.every((key) => key === 'surface'
    ? !!(state.dem || state.mesh || state.cloud)
    : !!state[key])
}

export function workflowRecipeText(workflow) {
  const lines = [`workflow ${JSON.stringify(workflow.name)}`,
    `defaults warning=${workflow.defaults.warningPolicy} reuse=${workflow.defaults.reusePolicy}`]
  for (const block of workflow.blocks) {
    const spec = WORKFLOW_BLOCK_BY_ID.get(block.type)
    const settings = Object.entries(block.settings || {})
      .filter(([, value]) => value != null)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`).join(' ')
    lines.push(`${block.enabled ? '' : '# '}${block.type}${settings ? ` ${settings}` : ''}  # ${spec?.label ?? block.type}`)
  }
  return lines.join('\n')
}

// Modal-equivalent settings resolution for blocks executed without opening their
// modal. Preset deltas are applied last; editing an individual preset-controlled
// field makes the builder mark the block `custom`.
export function resolveWorkflowSettings(type, settings = {}, runtime = {}) {
  const value = { ...settings }
  if (type === 'detect-features') {
    const isSuperPoint = value.detector === 'superpoint'
    const base = isSuperPoint ? DETECT_SUPERPOINT_DEFAULTS : DETECT_SIFT_DEFAULTS
    const presets = isSuperPoint ? DETECT_SUPERPOINT_PRESETS : DETECT_SIFT_PRESETS
    return { ...base, ...value, ...(presets[value.preset] || {}), useGpu: runtime.useGpu }
  }
  if (type === 'match-features') return { ...MATCH_DEFAULTS, ...value, ...(MATCH_PRESETS[value.preset] || {}), useGpu: runtime.useGpu }
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
    const { gsd, ...rest } = { ...DEM_DEFAULTS, ...value }
    return gsd > 0 ? { ...rest, gsd } : rest
  }
  if (type === 'gen-ortho') {
    const v = { ...ORTHO_DEFAULTS, ...value }
    return { ...v, gsd: v.gsd > 0 ? v.gsd : 0, depthTolRel: v.depthTolRel / 100, maxCost: v.maxCost > 0 ? v.maxCost : Infinity }
  }
  if (type === 'gen-mesh') return { ...MESH_DEFAULTS, ...value, ...(MESH_PRESETS[value.preset] || {}) }
  return value
}

// Apply one builder edit while keeping detector-specific defaults coherent. A
// detector switch is a schema switch, not an ordinary custom-field edit: carrying
// SIFT's 10k keypoint budget into SuperPoint defeats its deliberately low O(N²)
// LightGlue ceiling. Keep the selected named preset where possible; a custom set
// has no meaningful cross-detector equivalent, so reset it to the safe default.
export function updateWorkflowSetting(settings = {}, key, value) {
  if (key === 'detector' && (value === 'sift' || value === 'superpoint')) {
    const preset = ['low', 'medium', 'high'].includes(settings.preset) ? settings.preset : 'medium'
    const base = value === 'superpoint' ? DETECT_SUPERPOINT_DEFAULTS : DETECT_SIFT_DEFAULTS
    const presets = value === 'superpoint' ? DETECT_SUPERPOINT_PRESETS : DETECT_SIFT_PRESETS
    return {
      detector: value,
      preset,
      overwrite: settings.overwrite ?? false,
      ...base,
      ...(presets[preset] || {}),
    }
  }
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

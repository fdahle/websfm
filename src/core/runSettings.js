// What a processing dialog's settings become when a run starts (pure).
//
// The dialogs show settings in the user's units (a tolerance in %, 0 for "auto", the
// size field that `sizeBy` picks); the stores and workers take run units. The Reconstruct
// dialogs and the Workflow Builder both convert through these functions, so a block in a
// workflow runs exactly as the dialog would. Each takes the dialog's settings (missing
// keys fall back to the user defaults) and the runtime facts the dialog adds from
// Settings ▸ Compute ({ useGpu, memBudgetBytes, ramBudgetBytes }).

import {
  DEPTHMAP_DEFAULTS,
  DENSE_FUSE_DEFAULTS,
  DEM_DEFAULTS,
  ORTHO_DEFAULTS,
  MESH_DEFAULTS,
  MESH_PRESETS,
  TEXTURE_DEFAULTS,
} from './defaults.user.js'

const ram = (runtime) => (runtime.ramBudgetBytes > 0 ? { ramBudgetBytes: runtime.ramBudgetBytes } : {})

/** Depth Maps. The store keys kept maps on exactly this shape (depthReuse.js). */
export function depthRunSettings(ui = {}, runtime = {}) {
  const { filterRelTol, maxDim, bestK, ...rest } = { ...DEPTHMAP_DEFAULTS, ...ui }
  return {
    ...rest,
    filterRelTol: filterRelTol / 100,
    useGpu: runtime.useGpu,
    memBudgetBytes: runtime.memBudgetBytes,
    // Only when set: otherwise the run derives them (maxDim from quality, bestK per image).
    ...(maxDim > 0 ? { maxDim } : {}),
    ...(bestK > 0 ? { bestK } : {}),
  }
}

/** Build Dense Cloud (fusion). Automatic thresholds leave minViews and maxCost to the run. */
export function denseRunSettings(ui = {}, runtime = {}) {
  const v = { ...DENSE_FUSE_DEFAULTS, ...ui }
  return {
    minViews: v.auto ? null : v.minViews,
    maxCost: v.auto ? null : v.maxCost,
    depthTolRel: v.depthTolPct / 100,
    position: v.position,
    step: v.step,
    minTriAngleDeg: v.minTriAngleDeg,
    maxIncidenceDeg: v.maxIncidenceDeg,
    removeIsolated: v.removeIsolated,
    replaceMain: !!v.replaceMain,
    memBudgetBytes: runtime.memBudgetBytes,
    // The whole limit: fusion keeps its accumulators in wasm memory (fusionPlan.js).
    ...ram(runtime),
  }
}

/** Build DEM: only the size field `sizeBy` names, and only when set (0 ⇒ the worker's auto). */
export function demRunSettings(ui = {}, runtime = {}) {
  const { gsd, longSide, ...rest } = { ...DEM_DEFAULTS, ...ui }
  const size = rest.sizeBy === 'px' ? (longSide > 1 ? { longSide } : {}) : gsd > 0 ? { gsd } : {}
  // A plain array: a reactive one cannot be posted to the worker.
  return { ...rest, classes: [...(rest.classes ?? [])], memBudgetBytes: runtime.memBudgetBytes, ...size }
}

/** Build Orthophoto. Tolerance from %, max cost 0 ⇒ no limit, the size field `sizeBy` names. */
export function orthoRunSettings(ui = {}, runtime = {}) {
  const { depthTolRel, maxCost, gsd, longSide, ...rest } = { ...ORTHO_DEFAULTS, ...ui }
  const byPx = rest.sizeBy === 'px'
  return {
    ...rest,
    memBudgetBytes: runtime.memBudgetBytes,
    // The surface is built at its own natural resolution and the ortho grid is
    // resampled to `gsd` (or the long side in px); passing it through as the surface
    // GSD too would make a fine ortho pay for a needlessly fine mesh rasterisation.
    gsd: !byPx && gsd > 0 ? gsd : 0,
    longSide: byPx && longSide > 1 ? longSide : 0,
    depthTolRel: depthTolRel / 100,
    maxCost: maxCost > 0 ? maxCost : Infinity,
  }
}

/** Build Mesh. A named preset (a workflow block's) sets its fields over the others. */
export function meshRunSettings(ui = {}, runtime = {}) {
  return { ...MESH_DEFAULTS, ...ui, ...(MESH_PRESETS[ui.preset] || {}), ...ram(runtime) }
}

/** Texture Mesh. */
export function textureRunSettings(ui = {}, runtime = {}) {
  const s = { ...TEXTURE_DEFAULTS, ...ui }
  return {
    pageSize: Number(s.pageSize),
    maxPages: Math.max(1, Math.round(s.maxPages)),
    maxScale: Number(s.maxScale),
    smoothness: Math.max(0, s.smoothness),
    levelColours: !!s.levelColours,
    useMasks: !!s.useMasks,
    unseen: s.unseen,
    photoConsistency: !!s.photoConsistency,
    useGpu: !!runtime.useGpu,
    memBudgetBytes: runtime.memBudgetBytes,
  }
}

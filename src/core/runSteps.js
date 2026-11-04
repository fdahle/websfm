// The steps a long run goes through, for the progress dialog's step list: which are
// done, which runs now, which are still to come. A run names its current step as the
// `phase` of its progress reports (usePipeline report); the lists here give the
// order and the labels. A run declares its list when it opens the dialog, or, when it
// only knows its steps once it has started (Depth Maps on Auto picks Full or Fast by
// the GPU), with its first report.
import { SFM_PHASES } from './sfm/progressPlan.js'

/** @typedef {{ id: string, label: string }} RunStep */

/** @type {RunStep[]} */
export const SPARSE_STEPS = SFM_PHASES.map(({ key, label }) => ({ id: key, label }))

/** Depth maps: PatchMatch, then the Full method's geometric pass, then the cross-view filter. */
export function depthMapSteps({ geomPass = false, filter = true } = {}) {
  return [
    { id: 'pass1', label: geomPass ? 'PatchMatch, first pass' : 'PatchMatch' },
    ...(geomPass ? [{ id: 'pass2', label: 'PatchMatch, geometric pass' }] : []),
    ...(filter ? [{ id: 'filter', label: 'Cross-view filter' }] : []),
  ]
}

/** @type {RunStep[]} */
export const FUSION_STEPS = [
  { id: 'plan', label: 'Planning the fusion' },
  { id: 'fuse', label: 'Fusing the depth maps' },
]

/** @type {RunStep[]} */
export const MESH_STEPS = [
  { id: 'prepare', label: 'Preparing the points' },
  { id: 'tiles', label: 'Meshing the tiles' },
  { id: 'join', label: 'Joining the tiles' },
]

/**
 * Each step's state for the list: 'done' before the current one, 'running', 'todo'
 * after it, and 'skipped' for one before it that never reported (a step the run left
 * out, such as the position-constrained adjustment without control points).
 * steps RunStep[], phase the current step's id, seen the ids that have reported.
 * → [{ id, label, state }], or [] while the phase is not one of the steps.
 */
export function stepStates(steps, phase, seen = []) {
  const at = steps.findIndex((s) => s.id === phase)
  if (at < 0) return []
  const reported = new Set(seen)
  return steps.map((s, i) => ({
    ...s,
    state: i === at ? 'running' : i > at ? 'todo' : reported.has(s.id) ? 'done' : 'skipped',
  }))
}

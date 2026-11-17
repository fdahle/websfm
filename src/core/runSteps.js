// The steps a long run goes through, for the progress dialog's step list: which are
// done, which runs now, which are still to come. A run names its current step as the
// `phase` of its progress reports (usePipeline report); the lists here give the
// order and the labels. A run declares its list when it opens the dialog, or, when it
// only knows its steps once it has started (Depth Maps on Auto picks Full or Fast by
// the GPU), with its first report.
import { SFM_PHASES } from './sfm/progressPlan.js'

/**
 * A step owns the phase of its id and every `<id>-…` phase under it (matching's 'turn'
 * runs 'turn-probe', 'turn-detect', 'turn-match'). `optional`: it runs only when the run
 * finds it needed (a repair of a split graph). `units`: the unit a phase counts in, where
 * it is not the run's (detecting images again inside a run that counts pairs).
 * @typedef {{ id: string, label: string, optional?: boolean, units?: Record<string, string> }} RunStep
 */

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

/** Auto Mask: the edges (a strip or the film frame), then reading and masking the text. */
export function autoMaskSteps({ edges = 'off', text = false } = {}) {
  return [
    ...(edges === 'frame' ? [{ id: 'edges', label: 'Finding the film frames' }] : []),
    ...(edges === 'strip' ? [{ id: 'edges', label: 'Masking the edge strips' }] : []),
    ...(text
      ? [
          { id: 'read', label: 'Reading the text' },
          { id: 'mask', label: 'Masking the text' },
        ]
      : []),
  ]
}

/**
 * Matching: the pair pass, then the passes that can follow it, in run order
 * (stores/matching/matchAll.js). The later ones are optional: each runs only when the
 * graph needs it, so a step to come is said to run only if needed.
 */
export function matchSteps({ retrieval = false, rescue = false, bridge = false, gap = false, turn = false } = {}) {
  return [
    ...(retrieval ? [{ id: 'retrieval', label: 'Finding similar images' }] : []),
    { id: 'pairs', label: 'Matching the pairs' },
    ...(rescue ? [{ id: 'rescue', label: 'Re-testing pairs the quick check skipped', optional: true }] : []),
    ...(bridge ? [{ id: 'bridge', label: 'Repairing a split graph', optional: true }] : []),
    ...(gap
      ? [
          {
            id: 'gap',
            label: 'Detecting the gaps again at full size',
            optional: true,
            units: { 'gap-detect': 'images' },
          },
        ]
      : []),
    ...(turn
      ? [
          {
            id: 'turn',
            label: 'Finding turned photos',
            optional: true,
            units: { 'turn-probe': '', 'turn-detect': 'images' },
          },
        ]
      : []),
  ]
}

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
  const at = steps.findIndex((s) => ownsPhase(s, phase))
  if (at < 0) return []
  return steps.map((s, i) => ({
    ...s,
    state: i === at ? 'running' : i > at ? 'todo' : seen.some((p) => ownsPhase(s, p)) ? 'done' : 'skipped',
  }))
}

/** Whether `phase` is the step's own, or one of its `<id>-…` phases. */
export function ownsPhase(step, phase) {
  return !!phase && (phase === step.id || phase.startsWith(`${step.id}-`))
}

/** The unit the current phase counts in: its step's `units` entry, else the run's. */
export function phaseUnit(steps, phase, unit) {
  const step = steps.find((s) => ownsPhase(s, phase))
  return step?.units && phase in step.units ? step.units[phase] : unit
}

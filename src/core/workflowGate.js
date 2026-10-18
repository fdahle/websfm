// Quality gates for the Workflow Builder: which recorded Quality Report metrics a
// gate block can test, and how a measured value is judged. Pure (no Vue/stores);
// useWorkflowWiring measures the values from the same snapshot the Quality Report
// hub shows (useQualityReport.computeHealth), so a gate and the report can never
// disagree about a number.
//
// Each metric's default comparison is the report's own warn threshold
// (core/eval/health.js EVAL_THRESHOLDS): a gate left at its defaults passes exactly
// when the report would not colour that row as a warning.
import { EVAL_THRESHOLDS } from './eval/health.js'

// `needs` is the workflow state key (core/workflow.js) the metric is measured from:
// preflight refuses a gate placed where that output cannot exist yet. `health` is
// the projectHealth row id the value is read from; the point counts come from the
// clouds themselves. `abs` compares |value| (a signed focal delta).
const warnGate = (key) => ({
  op: EVAL_THRESHOLDS[key].dir === 'high' ? '>=' : '<',
  threshold: EVAL_THRESHOLDS[key].warn,
})
export const GATE_METRICS = [
  { id: 'registeredPct', label: 'Registered images', unit: '%', needs: 'sparse', health: 'registered', ...warnGate('registeredPct') },
  { id: 'reprojMedianPx', label: 'Reprojection median', unit: 'px', needs: 'sparse', health: 'reproj', ...warnGate('reprojMedianPx') },
  { id: 'track3ViewPct', label: '≥3-view tracks', unit: '%', needs: 'sparse', health: 'tracks', ...warnGate('track3ViewPct') },
  { id: 'sparsePoints', label: 'Sparse points', unit: '', needs: 'sparse', op: '>=', threshold: 1000 },
  { id: 'graphComponents', label: 'Match-graph components', unit: '', needs: 'matches', health: 'graph', ...warnGate('graphComponents') },
  { id: 'selfCalFitRmsPx', label: 'Self-cal warp fit RMS', unit: 'px', needs: 'sparse', health: 'selfcal', ...warnGate('selfCalFitRmsPx') },
  { id: 'focalDeltaPct', label: 'Focal Δ vs nominal', unit: '%', needs: 'sparse', health: 'focal', abs: true, ...warnGate('focalDeltaPct') },
  { id: 'gcpRmse', label: 'GCP RMSE', unit: 'CRS units', needs: 'sparse', health: 'gcp', ...warnGate('gcpRmse') },
  { id: 'poseRmse', label: 'Pose RMSE', unit: 'CRS units', needs: 'sparse', health: 'pose', ...warnGate('poseRmse') },
  { id: 'depthCoveragePct', label: 'Depth-map coverage', unit: '%', needs: 'depthMaps', health: 'depth', ...warnGate('depthCoveragePct') },
  { id: 'densePoints', label: 'Dense points', unit: '', needs: 'dense', op: '>=', threshold: 100000 },
  { id: 'demDzRmse', label: 'DEM ΔZ RMSE', unit: 'CRS units', needs: 'dem', health: 'dem', ...warnGate('demDzRmse') },
]
export const GATE_METRIC_BY_ID = new Map(GATE_METRICS.map((m) => [m.id, m]))
export const GATE_OPS = ['>=', '>', '<=', '<']
// What a failed gate does: ask, end the run as failed, carry on (recorded only), or
// jump to its fail target.
export const GATE_FAIL_ACTIONS = ['pause', 'stop', 'continue', 'branch']
// The reserved jump target that finishes the workflow (as completed).
export const END_TARGET = 'end'

// A gate's settings with this metric's default comparison. Switching metric resets
// op and threshold: a reprojection bound in px means nothing as a coverage share.
export function gateDefaults(metricId) {
  const m = GATE_METRIC_BY_ID.get(metricId) ?? GATE_METRICS[0]
  return { metric: m.id, op: m.op, threshold: m.threshold }
}

export function compareGate(value, op, threshold) {
  if (op === '>=') return value >= threshold
  if (op === '>') return value > threshold
  if (op === '<=') return value <= threshold
  if (op === '<') return value < threshold
  return false
}

// Judge a measured value. A metric the project cannot report (no GCPs for a GCP
// RMSE, no summary for the self-cal fit) is 'missing' and counts as a failure: a
// gate that cannot confirm quality must not wave the run through.
// → { outcome: 'pass' | 'fail' | 'missing', value, message }
export function evaluateGate(settings = {}, value) {
  const m = GATE_METRIC_BY_ID.get(settings.metric)
  const label = m?.label ?? settings.metric
  const unit = m?.unit ? ` ${m.unit}` : ''
  const condition = `${label} ${settings.op} ${formatGateNumber(settings.threshold)}${unit}`
  if (value == null || !Number.isFinite(value)) {
    return { outcome: 'missing', value: null, message: `${label}: not available — gate fails (needs ${condition})` }
  }
  const v = m?.abs ? Math.abs(value) : value
  const pass = compareGate(v, settings.op, Number(settings.threshold))
  return {
    outcome: pass ? 'pass' : 'fail',
    value,
    message: `${label} ${formatGateNumber(value)}${unit} — ${pass ? 'meets' : 'fails'} ${settings.op} ${formatGateNumber(settings.threshold)}${unit}`,
  }
}

// Read one metric from the Quality Report's health rows (projectHealth output) and
// the cloud counts. → number | null.
export function gateMetricValue(metricId, { rows = [], sparsePoints = null, densePoints = null } = {}) {
  if (metricId === 'sparsePoints') return sparsePoints
  if (metricId === 'densePoints') return densePoints
  const m = GATE_METRIC_BY_ID.get(metricId)
  if (!m?.health) return null
  const row = rows.find((r) => r.id === m.health)
  return row?.value ?? null
}

export function formatGateNumber(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—'
  const n = Number(v)
  if (Number.isInteger(n)) return n.toLocaleString('en-US')
  return Math.abs(n) >= 100 ? n.toFixed(1) : Math.abs(n) >= 1 ? n.toFixed(2) : n.toPrecision(3)
}

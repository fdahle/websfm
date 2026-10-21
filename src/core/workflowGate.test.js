import { describe, expect, it } from 'vitest'
import { EVAL_THRESHOLDS, classify, projectHealth } from './eval/health.js'
import { GATE_METRICS, evaluateGate, gateDefaults, gateMetricValue } from './workflowGate.js'

describe('quality gate metrics', () => {
  it('default to the Quality Report warn threshold: a default gate passes exactly when the row is ok', () => {
    const pairs = {
      registeredPct: 'registeredPct',
      reprojMedianPx: 'reprojMedianPx',
      track3ViewPct: 'track3ViewPct',
      graphComponents: 'graphComponents',
      depthCoveragePct: 'depthCoveragePct',
      focalDeltaPct: 'focalDeltaPct',
      gcpRmse: 'gcpRmse',
    }
    for (const [metric, row] of Object.entries(pairs)) {
      const thr = EVAL_THRESHOLDS[row]
      for (const value of [thr.warn * 0.5, thr.warn, thr.warn * 1.5, -thr.warn * 1.5]) {
        const gate = evaluateGate(gateDefaults(metric), value)
        const status = classify(value, thr)
        expect(gate.outcome === 'pass', `${metric} ${value}`).toBe(status === 'ok')
      }
    }
  })

  it('compares with the chosen operator; a missing value fails', () => {
    expect(evaluateGate({ metric: 'densePoints', op: '>', threshold: 10 }, 10).outcome).toBe('fail')
    expect(evaluateGate({ metric: 'densePoints', op: '>=', threshold: 10 }, 10).outcome).toBe('pass')
    expect(evaluateGate({ metric: 'reprojMedianPx', op: '<=', threshold: 1 }, 1).outcome).toBe('pass')
    expect(evaluateGate({ metric: 'reprojMedianPx', op: '<', threshold: 1 }, null)).toMatchObject({
      outcome: 'missing',
      value: null,
    })
    expect(evaluateGate({ metric: 'reprojMedianPx', op: '<', threshold: 1 }, NaN).outcome).toBe('missing')
    expect(evaluateGate({ metric: 'reprojMedianPx', op: '<', threshold: 1 }, 0.42).message).toBe(
      'Reprojection median 0.420 px — meets < 1 px',
    )
  })

  it('reads the values from the same health rows the Quality Report shows', () => {
    const rows = projectHealth({
      imageCount: 10,
      registeredCount: 8,
      reproj: { median: 0.7 },
      depth: { coveragePct: 61 },
    })
    expect(gateMetricValue('registeredPct', { rows })).toBe(80)
    expect(gateMetricValue('reprojMedianPx', { rows })).toBe(0.7)
    expect(gateMetricValue('depthCoveragePct', { rows })).toBe(61)
    expect(gateMetricValue('gcpRmse', { rows })).toBeNull()
    expect(gateMetricValue('densePoints', { rows, densePoints: 5 })).toBe(5)
    for (const m of GATE_METRICS)
      expect(['images', 'matches', 'sparse', 'depthMaps', 'dense', 'dem']).toContain(m.needs)
  })
})

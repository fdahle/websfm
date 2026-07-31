import { describe, it, expect } from 'vitest'
import { classify, thresholdHint, projectHealth, EVAL_THRESHOLDS } from './health.js'

describe('classify', () => {
  it('null value → missing', () => {
    expect(classify(null, EVAL_THRESHOLDS.reprojMedianPx)).toBe('missing')
  })
  it('low-dir: bigger is worse', () => {
    const thr = { warn: 1, bad: 2, dir: 'low' }
    expect(classify(0.5, thr)).toBe('ok')
    expect(classify(1.0, thr)).toBe('warn')
    expect(classify(2.5, thr)).toBe('bad')
  })
  it('high-dir: smaller is worse', () => {
    const thr = { warn: 90, bad: 70, dir: 'high' }
    expect(classify(95, thr)).toBe('ok')
    expect(classify(80, thr)).toBe('warn')
    expect(classify(50, thr)).toBe('bad')
  })
  it('low-abs uses magnitude', () => {
    const thr = { warn: 5, bad: 15, dir: 'low-abs' }
    expect(classify(-3, thr)).toBe('ok')
    expect(classify(-8, thr)).toBe('warn')
    expect(classify(20, thr)).toBe('bad')
  })
})

describe('thresholdHint', () => {
  it('phrases by direction', () => {
    expect(thresholdHint({ warn: 1, dir: 'low' }, 'px')).toBe('warn > 1 px')
    expect(thresholdHint({ warn: 90, dir: 'high' }, '%')).toBe('warn < 90 %')
    expect(thresholdHint({ warn: 5, dir: 'low-abs' }, '%')).toBe('warn > ±5 %')
  })
})

describe('projectHealth', () => {
  it('marks missing prerequisites without dropping the row', () => {
    const rows = projectHealth({})
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    // Every canonical row is present even on an empty snapshot.
    for (const id of ['registered', 'reproj', 'tracks', 'graph', 'selfcal', 'focal', 'gcp', 'pose', 'dem', 'depth'])
      expect(byId[id]).toBeTruthy()
    expect(byId.reproj.status).toBe('missing')
    expect(byId.gcp.status).toBe('missing')
    expect(byId.gcp.hint).toMatch(/GCP/i)
  })

  it('computes registered %, reproj, ≥3-view %, graph and colours them', () => {
    const rows = projectHealth({
      imageCount: 10,
      registeredCount: 10,
      reproj: { median: 0.6, p95: 2, max: 5, n: 100 },
      histogram: [
        { views: 2, count: 40, pct: 40 },
        { views: 3, count: 30, pct: 30 },
        { views: 4, count: 30, pct: 30 },
        { views: '8+', count: 0, pct: 0 },
      ],
      graph: { components: [['a', 'b', 'c']], isolated: [] },
    })
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId.registered.value).toBe(100)
    expect(byId.registered.status).toBe('ok')
    expect(byId.reproj.status).toBe('ok')
    expect(byId.tracks.value).toBeCloseTo(60, 5) // 60 of 100 in ≥3-view bins
    expect(byId.graph.value).toBe(1)
    expect(byId.graph.status).toBe('ok')
  })

  it('treats sub-quarter-pixel composed warp error as healthy', () => {
    const row = projectHealth({ selfCal: [{ sensorId: 's1', fitRmsPx: 0.2 }] })
      .find((r) => r.id === 'selfcal')
    expect(row.label).toBe('Self-cal warp fit RMS')
    expect(row.status).toBe('ok')
  })

  it('flags a split graph and a low registration rate', () => {
    const rows = projectHealth({
      imageCount: 10, registeredCount: 6,
      graph: { components: [['a', 'b'], ['c']], isolated: ['d'] },
    })
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId.registered.status).toBe('bad')   // 60% < 70
    expect(byId.graph.status).toBe('warn')       // 2 components
    expect(byId.graph.hint).toMatch(/isolated/)
  })

  it('computes GCP/pose/DEM RMSE from report rows', () => {
    const rows = projectHealth({
      gcpReport: [{ dTotal: 0.3 }, { dTotal: 0.4 }, { dTotal: null }],
      poseReport: [{ dTotal: 3 }, { dTotal: 4 }],
      demCheck: [{ dz: 0.5 }, { dz: -0.5 }],
      crsUnit: 'm',
    })
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]))
    expect(byId.gcp.value).toBeCloseTo(Math.sqrt((0.09 + 0.16) / 2), 6)
    expect(byId.gcp.status).toBe('ok')
    expect(byId.pose.value).toBeCloseTo(Math.sqrt((9 + 16) / 2), 6)
    expect(byId.pose.status).toBe('warn') // 3.53 ≥ 2
    expect(byId.dem.value).toBeCloseTo(0.5, 6)
  })
})

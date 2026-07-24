import { describe, it, expect } from 'vitest'
import { buildProjectDigest, digestToMarkdown, digestToJson } from './summaryDigest.js'

const ROWS = [
  { id: 'registered', section: 'sparse', label: 'Registered images', value: 96.7, unit: '%', status: 'ok', hint: '118 / 122' },
  { id: 'reproj', section: 'sparse', label: 'Reprojection median', value: 1.34, unit: 'px', status: 'warn', hint: 'warn > 1' },
  { id: 'graph', section: 'matching', label: 'Match-graph components', value: 1, unit: '', status: 'ok', hint: '' },
  { id: 'gcp', section: 'accuracy', label: 'GCP RMSE', value: null, unit: 'm', status: 'missing', hint: 'no georef' },
]

const INPUT = {
  projectName: 'Antarctica_1972',
  date: '2026-07-24T00:00:00.000Z',
  crsUnit: 'm',
  rows: ROWS,
  snapshot: {},
  offenders: {
    residuals: [{ name: 'IMG_001.jpg', nObs: 312, rmsPx: 2.4 }],
    unregistered: [{ name: 'IMG_099.jpg', reason: 'no accepted pairs' }],
  },
  summary: { nCameras: 118, nPoints: 45210, pct3plusViewTracks: 74, preBaP95px: 3.1, postBaMedianPx: 0.8 },
  denseSummary: { costMedian: 0.12, keptPct: 61, cullBreakdown: { sky: 1200, grazing: 300 } },
}

describe('buildProjectDigest', () => {
  it('rolls up status counts and picks worst tone overall', () => {
    const d = buildProjectDigest(INPUT)
    expect(d.status).toMatchObject({ ok: 2, warn: 1, bad: 0, missing: 1 })
    expect(d.status.overall).toBe('warn')
  })

  it('overall is bad when any row is bad', () => {
    const d = buildProjectDigest({ ...INPUT, rows: [{ section: 's', status: 'bad', label: 'x', value: 9 }] })
    expect(d.status.overall).toBe('bad')
  })

  it('groups health rows by section in first-seen order', () => {
    const d = buildProjectDigest(INPUT)
    expect(d.health.map((g) => g.section)).toEqual(['sparse', 'matching', 'accuracy'])
    expect(d.health[0].rows).toHaveLength(2)
  })

  it('carries offenders and run figures', () => {
    const d = buildProjectDigest(INPUT)
    expect(d.offenders.residuals[0]).toMatchObject({ name: 'IMG_001.jpg', rmsPx: 2.4 })
    expect(d.run.sparse.cameras).toBe(118)
    expect(d.run.dense.keptPct).toBe(61)
  })

  it('run sections are null when summaries are absent', () => {
    const d = buildProjectDigest({ ...INPUT, summary: null, denseSummary: null })
    expect(d.run.sparse).toBeNull()
    expect(d.run.dense).toBeNull()
  })
})

describe('digestToMarkdown', () => {
  const md = digestToMarkdown(buildProjectDigest(INPUT))

  it('leads with project, status and health', () => {
    expect(md).toContain('# websfm project summary — Antarctica_1972')
    expect(md).toContain('STATUS: **warn** — 2 ok · 1 warn · 0 bad · 1 n/a')
    expect(md).toContain('[warn]')
  })

  it('renders values with units and a missing row as an em dash', () => {
    expect(md).toContain('Reprojection median: 1.34 px')
    expect(md).toContain('GCP RMSE: —')
  })

  it('includes offenders and run details', () => {
    expect(md).toContain('IMG_001.jpg: 2.40 px  (312 obs)')
    expect(md).toContain('IMG_099.jpg: no accepted pairs')
    expect(md).toContain('cameras 118')
    expect(md).toContain('culls {sky=1200, grazing=300}')
  })
})

describe('digestToJson', () => {
  it('round-trips the digest object', () => {
    const d = buildProjectDigest(INPUT)
    expect(JSON.parse(digestToJson(d))).toEqual(d)
  })
})

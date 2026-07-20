import { describe, it, expect } from 'vitest'
import { diffSummaries } from './compareRuns.js'

const A = { nCameras: 40, nPoints: 10000, pct3plusViewTracks: 55, postBaMedianPx: 0.9, preBaP95px: 2.1 }

describe('diffSummaries', () => {
  it('no previous run → same verdicts, null prev', () => {
    const rows = diffSummaries(A, null)
    expect(rows).toHaveLength(5)
    for (const r of rows) { expect(r.prev).toBeNull(); expect(r.verdict).toBe('same') }
  })

  it('scores higher-is-better and lower-is-better metrics', () => {
    const B = { nCameras: 45, nPoints: 9000, pct3plusViewTracks: 60, postBaMedianPx: 0.7, preBaP95px: 2.3 }
    const rows = diffSummaries(B, A)
    const by = Object.fromEntries(rows.map((r) => [r.key, r]))
    expect(by.nCameras.verdict).toBe('better')       // 45 > 40
    expect(by.nPoints.verdict).toBe('worse')         // 9000 < 10000
    expect(by.pct3plusViewTracks.verdict).toBe('better')
    expect(by.postBaMedianPx.verdict).toBe('better') // 0.7 < 0.9 (lower better)
    expect(by.preBaP95px.verdict).toBe('worse')      // 2.3 > 2.1
    expect(by.nCameras.delta).toBe(5)
  })

  it('drops metrics absent from both, keeps one-sided ones with null delta', () => {
    const rows = diffSummaries({ nCameras: 10 }, { nPoints: 5 })
    const keys = rows.map((r) => r.key)
    expect(keys).toContain('nCameras')
    expect(keys).toContain('nPoints')
    expect(keys).not.toContain('postBaMedianPx')
    expect(rows.find((r) => r.key === 'nCameras').delta).toBeNull()
  })

  it('treats an unchanged value as same', () => {
    const rows = diffSummaries(A, { ...A })
    for (const r of rows) expect(r.verdict).toBe('same')
  })
})

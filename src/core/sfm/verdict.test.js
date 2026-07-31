import { describe, it, expect } from 'vitest'
import { buildVerdict } from './verdict.js'

// A healthy run (all thresholds cleared) as the baseline to perturb.
const healthy = () => ({
  imageCount: 50, registeredCount: 49, nPoints: 20000,
  reprojMedianPx: 0.6, reprojP95px: 1.4, track3ViewPct: 55,
  graphComponents: 1, focalDeltaPct: 1,
})

const codes = (v) => v.findings.map((f) => f.code)

describe('buildVerdict', () => {
  it('a healthy run is green with no findings', () => {
    const v = buildVerdict(healthy())
    expect(v.level).toBe('green')
    expect(v.findings).toEqual([])
    expect(v.headline).toMatch(/Looks good/)
  })

  it('a degenerate run is red and short-circuits other checks', () => {
    const v = buildVerdict({ imageCount: 50, registeredCount: 1, nPoints: 0, track3ViewPct: 5 })
    expect(v.level).toBe('red')
    expect(codes(v)).toEqual(['failed']) // only the failure, not weak-geometry etc.
  })

  it('flags low registration and lists a few unregistered names', () => {
    const v = buildVerdict({
      ...healthy(), imageCount: 50, registeredCount: 17,
      unregistered: [{ name: 'a.jpg' }, { name: 'b.jpg' }, { name: 'c.jpg' }, { name: 'd.jpg' }, { name: 'e.jpg' }, { name: 'f.jpg' }],
    })
    expect(v.level).toBe('red') // 34% < bad(70)
    const reg = v.findings.find((f) => f.code === 'registration')
    expect(reg.title).toMatch(/17\/50/)
    expect(reg.title).toMatch(/e\.jpg, …/) // capped at 5 + ellipsis
    expect(reg.fix).toMatch(/diagnostics first/i)
  })

  it('detects the distortion fingerprint (p95 ≫ median) — B1 shape', () => {
    const v = buildVerdict({ ...healthy(), reprojMedianPx: 1.0, reprojP95px: 30 })
    const d = v.findings.find((f) => f.code === 'distortion')
    expect(d).toBeTruthy()
    expect(d.level).toBe('red') // 30× ≥ bad(5)
    expect(d.fix).toMatch(/self-calibration/i)
    // The absolute-median finding must NOT double-report when distortion already fired.
    expect(codes(v)).not.toContain('reprojection')
  })

  it('yellow distortion tail at 3–5×', () => {
    const v = buildVerdict({ ...healthy(), reprojMedianPx: 1.0, reprojP95px: 3.5 })
    expect(v.findings.find((f) => f.code === 'distortion').level).toBe('yellow')
  })

  it('does not tell a completed self-cal run to enable self-calibration', () => {
    const v = buildVerdict({ ...healthy(), reprojMedianPx: 0.3, reprojP95px: 1.8, selfCalResolved: 'f,k1' })
    const tail = v.findings.find((f) => f.code === 'reprojection-tail')
    expect(tail).toBeTruthy()
    expect(tail.fix).toMatch(/already ran/i)
    expect(tail.fix).not.toMatch(/enable self-calibration/i)
  })

  it('a high median with no tail reports reprojection, not distortion', () => {
    const v = buildVerdict({ ...healthy(), reprojMedianPx: 2.5, reprojP95px: 4.0 }) // ratio 1.6×
    expect(codes(v)).toContain('reprojection')
    expect(codes(v)).not.toContain('distortion')
  })

  it('flags a weakly-constrained block below 20% ≥3-view — B1 shape', () => {
    const v = buildVerdict({ ...healthy(), track3ViewPct: 9.5 })
    const w = v.findings.find((f) => f.code === 'weak-geometry')
    expect(w.level).toBe('yellow')
    expect(w.title).toMatch(/10%/) // 9.5 rounds to 10 in the message
    // 40% (hub-warn but above the act threshold) does NOT raise a verdict finding.
    expect(codes(buildVerdict({ ...healthy(), track3ViewPct: 40 }))).not.toContain('weak-geometry')
  })

  it('flags a split match graph', () => {
    expect(codes(buildVerdict({ ...healthy(), graphComponents: 3 }))).toContain('graph-split')
    expect(codes(buildVerdict({ ...healthy(), graphComponents: 1 }))).not.toContain('graph-split')
  })

  it('flags a large focal delta', () => {
    const v = buildVerdict({ ...healthy(), focalDeltaPct: 20 })
    expect(v.findings.find((f) => f.code === 'focal').title).toMatch(/20%/)
    // 7.4% (SB fingerprint) is a warn, still surfaced as yellow.
    expect(buildVerdict({ ...healthy(), focalDeltaPct: 7.4 }).findings.find((f) => f.code === 'focal').level).toBe('yellow')
  })

  it('flags thin dense depth coverage (and stays silent when absent)', () => {
    // Absent (sparse-only run) → no finding, still green.
    expect(codes(buildVerdict(healthy()))).not.toContain('depth-coverage')
    // < warn(50) → yellow; < bad(25) → red.
    expect(buildVerdict({ ...healthy(), depthCoveragePct: 40 }).findings.find((f) => f.code === 'depth-coverage').level).toBe('yellow')
    expect(buildVerdict({ ...healthy(), depthCoveragePct: 15 }).findings.find((f) => f.code === 'depth-coverage').level).toBe('red')
  })

  it('orders findings worst-first and reports the overall level', () => {
    const v = buildVerdict({
      ...healthy(), registeredCount: 17, // red
      graphComponents: 2,                // yellow
      track3ViewPct: 10,                 // yellow
    })
    expect(v.level).toBe('red')
    expect(v.findings[0].level).toBe('red')
    // yellows follow the single red
    expect(v.findings.slice(1).every((f) => f.level === 'yellow')).toBe(true)
    expect(v.headline).toMatch(/Serious problems/)
  })

  it('handles a sparse snapshot with missing fields (no throw, no false findings)', () => {
    const v = buildVerdict({ registeredCount: 40, imageCount: 45 }) // 88% → warn only
    expect(v.level).toBe('yellow')
    expect(codes(v)).toEqual(['registration'])
  })
})

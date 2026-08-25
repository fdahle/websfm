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

  // ── Contributing-cause rules ────────────────────────────────────────────────
  // The defining property of all three: SILENT on a clean run, because none is a
  // defect on its own. A green run that saturates the cap, skips the cycle filter and
  // leaves the track filter inert is still a good reconstruction. The unconditional
  // record is the digest's job; these only explain a finding that already fired.
  const contributing = () => ({
    filterMaxReprojPx: 9.12, detectScaleFactor: 2.28, maxDim: 2400,
    kpCapHitPct: 100, maxKeypoints: 10000,
    cycleFilterAborted: true, cycleMedianTriErrDeg: 40, degeneratePairPct: 80,
  })
  // The 4.7× tail of the 2026-08-18 DJI run. selfCalResolved is what makes it code as
  // 'reprojection-tail' rather than 'distortion' — self-cal had already run.
  const tail = () => ({ reprojMedianPx: 0.86, reprojP95px: 4.0, selfCalResolved: 'f,k1' })

  it('stays silent on a healthy run even when every contributing cause is present', () => {
    const v = buildVerdict({ ...healthy(), ...contributing() })
    expect(v.level).toBe('green')
    expect(v.findings).toEqual([])
  })

  // The 2026-08-18 DJI run: 127/127 registered, 0.86 px median, 4.0 px p95 → a 4.7×
  // tail, under a 9.12 px track filter that therefore removed nothing.
  it('explains a residual tail that the track filter never bit on', () => {
    const v = buildVerdict({
      ...healthy(), ...tail(), ...contributing(),
    })
    expect(codes(v)).toContain('reprojection-tail')
    const g = v.findings.find((f) => f.code === 'gate-headroom')
    expect(g.title).toMatch(/2\.3× above the observed p95/)
    expect(g.fix).toMatch(/maxDim 2400/)      // names the actual cause of the ×2.28
    expect(g.fix).toMatch(/×2\.28/)
  })

  it('gate-headroom is silent when the gate is tight, tail or not', () => {
    const v = buildVerdict({
      ...healthy(), ...tail(),
      ...contributing(), filterMaxReprojPx: 4.5, // 1.1× headroom
    })
    expect(codes(v)).toContain('reprojection-tail')
    expect(codes(v)).not.toContain('gate-headroom')
  })

  it('omits the scale note when detection ran near native resolution', () => {
    const v = buildVerdict({
      ...healthy(), ...tail(),
      ...contributing(), detectScaleFactor: 1.05,
    })
    expect(v.findings.find((f) => f.code === 'gate-headroom').fix).not.toMatch(/maxDim/)
  })

  it('flags a saturated keypoint cap only alongside a structural finding', () => {
    const v = buildVerdict({
      ...healthy(), ...tail(), ...contributing(),
    })
    expect(v.findings.find((f) => f.code === 'keypoint-cap').title).toMatch(/100%.*10000 keypoint cap/)
    // 50% saturation is not the cap doing the selecting → silent.
    const v2 = buildVerdict({
      ...healthy(), ...tail(), ...contributing(), kpCapHitPct: 50,
    })
    expect(codes(v2)).not.toContain('keypoint-cap')
  })

  // The abort has two causes with OPPOSITE fixes, and the degeneracy share is what
  // separates them — so the finding must say which one it is looking at.
  it('attributes a cycle-filter abort to planar geometry when pairs are degenerate', () => {
    const v = buildVerdict({
      ...healthy(), ...tail(), ...contributing(),
    })
    const c = v.findings.find((f) => f.code === 'cycle-filter-skipped')
    expect(c.title).toMatch(/40°/)
    expect(c.fix).toMatch(/80% of accepted pairs are H\/F-degenerate/)
    expect(c.fix).toMatch(/not fixable by calibration/)
  })

  it('attributes a cycle-filter abort to intrinsics when few pairs are degenerate', () => {
    const v = buildVerdict({
      ...healthy(), ...tail(),
      ...contributing(), degeneratePairPct: 5,
    })
    const c = v.findings.find((f) => f.code === 'cycle-filter-skipped')
    expect(c.fix).toMatch(/wrong intrinsics/)
    expect(c.fix).not.toMatch(/not fixable by calibration/) // not the planar attribution
  })

  it('an unrecorded degeneracy share falls back to the intrinsics explanation', () => {
    const v = buildVerdict({
      ...healthy(), ...tail(),
      ...contributing(), degeneratePairPct: null,
    })
    expect(v.findings.find((f) => f.code === 'cycle-filter-skipped').fix).toMatch(/wrong intrinsics/)
  })
})

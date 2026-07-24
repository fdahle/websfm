import { describe, it, expect } from 'vitest'
import { preflight, hasBlockers } from './preflight.js'

const GiB = 1024 ** 3
// A clean, runnable project as the baseline to perturb.
const ready = () => ({
  nImages: 10, detectedImageCount: 10, verifiedPairCount: 30, totalPairCount: 45,
  sensorsMissingFocal: [], filmSensorsMissingFiducials: [], dense: null, gpu: null,
})
const codes = (list) => list.map((c) => c.code)

describe('preflight', () => {
  it('a ready project has no checks', () => {
    expect(preflight(ready())).toEqual([])
    expect(hasBlockers(preflight(ready()))).toBe(false)
  })

  it('blocks with fewer than 2 images', () => {
    const c = preflight({ nImages: 1 })
    expect(c[0].level).toBe('block')
    expect(c[0].code).toBe('too-few-images')
    expect(hasBlockers(c)).toBe(true)
  })

  it('blocks when no image has keypoints', () => {
    const c = preflight({ ...ready(), detectedImageCount: 0 })
    expect(codes(c)).toContain('no-keypoints')
    expect(hasBlockers(c)).toBe(true)
  })

  it('distinguishes "no matches" from "all pairs disabled"', () => {
    expect(codes(preflight({ ...ready(), verifiedPairCount: 0, totalPairCount: 0 }))).toContain('no-matches')
    expect(codes(preflight({ ...ready(), verifiedPairCount: 0, totalPairCount: 12 }))).toContain('all-pairs-disabled')
  })

  it('does not flag matches before detection has run', () => {
    // detectedImageCount 0 already blocks; the pairs check must not also fire.
    const c = preflight({ nImages: 5, detectedImageCount: 0, verifiedPairCount: 0, totalPairCount: 0 })
    expect(codes(c)).toContain('no-keypoints')
    expect(codes(c)).not.toContain('no-matches')
  })

  it('warns (not blocks) on a sensor missing focal, listing labels', () => {
    const c = preflight({ ...ready(), sensorsMissingFocal: [{ label: 'Canon 5D' }, { label: 'RMK' }] })
    const w = c.find((x) => x.code === 'missing-focal')
    expect(w.level).toBe('warn')
    expect(w.msg).toMatch(/Canon 5D, RMK/)
    expect(hasBlockers(c)).toBe(false)
  })

  it('warns on a film sensor without fiducials', () => {
    const c = preflight({ ...ready(), filmSensorsMissingFiducials: [{ label: 'Wild RC8' }] })
    expect(c.find((x) => x.code === 'film-no-fiducials').level).toBe('warn')
  })

  it('warns when the dense projection exceeds the budget', () => {
    expect(codes(preflight({ ...ready(), dense: { projectedBytes: 5 * GiB, budgetBytes: 2 * GiB } }))).toContain('dense-over-budget')
    // Under budget → no warning.
    expect(codes(preflight({ ...ready(), dense: { projectedBytes: 1 * GiB, budgetBytes: 2 * GiB } }))).not.toContain('dense-over-budget')
  })

  it('warns when GPU is requested but unavailable, not when available', () => {
    expect(codes(preflight({ ...ready(), gpu: { requested: true, available: false } }))).toContain('gpu-unavailable')
    expect(codes(preflight({ ...ready(), gpu: { requested: true, available: true } }))).not.toContain('gpu-unavailable')
    expect(codes(preflight({ ...ready(), gpu: { requested: false, available: false } }))).not.toContain('gpu-unavailable')
  })

  it('orders blocks before warnings', () => {
    const c = preflight({
      nImages: 1, // block
      sensorsMissingFocal: [{ label: 'x' }], // warn
    })
    expect(c[0].level).toBe('block')
    expect(c[c.length - 1].level).toBe('warn')
  })

  it('every check carries a non-empty msg and fix', () => {
    const c = preflight({ nImages: 1, sensorsMissingFocal: [{ label: 'x' }], filmSensorsMissingFiducials: [{ label: 'y' }],
      dense: { projectedBytes: 5 * GiB, budgetBytes: 1 * GiB }, gpu: { requested: true, available: false } })
    for (const x of c) {
      expect(x.msg.length).toBeGreaterThan(0)
      expect(x.fix.length).toBeGreaterThan(0)
    }
  })

  it('handles an empty snapshot without throwing (treated as no images)', () => {
    const c = preflight()
    expect(codes(c)).toEqual(['too-few-images'])
  })
})

import { describe, expect, it } from 'vitest'
import { resolveRefineIntrinsics } from './runRecord.js'

const run = (flags) => {
  const cfg = { refineIntrinsics: 'auto' }, record = {}, lines = []
  resolveRefineIntrinsics({ cfg, selfCalRecord: record, log: (m) => lines.push(m), ...flags })
  return { cfg, record, lines }
}

describe("resolveRefineIntrinsics 'auto'", () => {
  it('stages self-calibration for an uncalibrated camera', () => {
    const { cfg } = run({ anyCalibratedDistortion: false })
    expect(cfg.refineIntrinsics).toBe('f,k1')
    expect(cfg.selfCalStaged).toBe(true)
  })
  it('holds a reseau-calibrated film camera (SAT-5), and says so', () => {
    const { cfg, record, lines } = run({ anyCalibratedDistortion: false, anyReseauCalibrated: true })
    expect(cfg.refineIntrinsics).toBe('none')
    expect(record.resolved).toBe('none')
    expect(lines[0]).toMatch(/reseau-calibrated/)
  })
  it('leaves an explicit choice alone', () => {
    const cfg = { refineIntrinsics: 'f' }
    resolveRefineIntrinsics({ cfg, anyReseauCalibrated: true, selfCalRecord: {}, log: () => {} })
    expect(cfg.refineIntrinsics).toBe('f')
  })
})

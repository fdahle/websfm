import { describe, it, expect } from 'vitest'
import { medianScore, scoreOf } from './scoreboard.mjs'

describe('medianScore (--repeat)', () => {
  it('takes the median of every number, keeping the shape', () => {
    const run = (h, v, cams) => ({ cameras: [cams, 347], checkpoints: { h, v, meanU: null, n: 3 }, dem: null })
    expect(medianScore([run(0.05, 0.2, 346), run(0.04, 0.3, 347), run(0.06, 0.1, 347)])).toEqual({
      cameras: [347, 347],
      checkpoints: { h: 0.05, v: 0.2, meanU: null, n: 3 },
      dem: null,
    })
    // An even count: the mean of the middle two.
    expect(medianScore([run(0.04, 0.2, 346), run(0.06, 0.4, 347)]).checkpoints.v).toBeCloseTo(0.3, 12)
  })

  it('is the run itself for one run, and null for none', () => {
    const one = { cameras: [1, 2] }
    expect(medianScore([one])).toBe(one)
    expect(medianScore([])).toBeNull()
  })
})

describe('scoreOf', () => {
  // ETH3D rows as eth3d_score.py and eth3d_official.py write them (percent).
  const rows = (f1At2) => ({
    rows: [
      { tolerance: 0.01, accuracy: 50, completeness: 40, f1: 44.4 },
      { tolerance: 0.02, accuracy: 80, completeness: 70, f1: f1At2 },
      { tolerance: 0.05, accuracy: 95, completeness: 85, f1: 89.7 },
    ],
  })

  it('reads the 2 cm row of both ETH3D scorers, each into its own field', () => {
    const x = scoreOf('websfm', { stages: {} }, { eth3d: rows(70.1), eth3dOfficial: rows(74.8) })
    expect(x.dense.f1).toBe(70.1)
    expect(x.denseOfficial).toEqual({ f1: 74.8, accuracy: 80, completeness: 70 })
    expect(scoreOf('websfm', { stages: {} }, { eth3d: rows(70.1) }).denseOfficial).toBeNull()
  })

  it("times COLMAP's dense from undistortion, PatchMatch and fusion, not its SfM", () => {
    const s = {
      registered: 38,
      images: 38,
      seconds: { undistort: 10, patchmatch: 300, fusion: 40, features: 99, sfmTotal: 99 },
      dense: { points: 1e6 },
    }
    expect(scoreOf('colmap', s).denseSeconds).toBe(350)
    // A sparse-only COLMAP run has no dense time.
    expect(scoreOf('colmap', { ...s, dense: null }).denseSeconds).toBeNull()
  })

  it('scores a COLMAP film run by its leave-one-out checkpoints and its DEM', () => {
    const s = {
      georef: { registered: 36, loo_rms_h: 1.18, loo_rms_v: 14.1, fit_rms_h: 0.9, fit_rms_v: 10 },
      images: 37,
      checkpoints: 44,
      dem_score: { rmse_diff: 13.0, nmad_diff: 13.5, dem_valid_share_of_bbox: 0.5 },
      timings: { features: 100, matching: 200, mapper: 300, patch_match: 5000 },
    }
    expect(scoreOf('colmap-hist', s)).toMatchObject({
      cameras: [36, 37],
      checkpoints: { h: 1.18, v: 14.1, n: 44 },
      dem: { rmse: 13.0, nmad: 13.5, coverage: 0.5 },
      sfmSeconds: 600,
    })
  })
})

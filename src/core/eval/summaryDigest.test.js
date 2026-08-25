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

  it('top-level status cannot be greener than the verdict', () => {
    const d = buildProjectDigest({ ...INPUT, verdict: { level: 'red', headline: 'tail', findings: [] } })
    expect(d.status.healthOverall).toBe('warn')
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

// ── Baseline record (run config + diagnostics) ─────────────────────────────────
// These sections exist so a pasted digest is a complete baseline entry: what was run,
// which seed won, how the gates resolved, what the match gates did. A regression here
// silently turns a baseline back into an unattributable set of numbers.

const B4 = {
  ...INPUT,
  detect: {
    detector: 'sift', images: 128, maxDim: 2400, maxDimMode: 'absolute',
    maxKeypoints: 10000, contrastThreshold: 0.01, tiling: 'off',
    medianKeypoints: 9800, medianDetectScale: 0.78, mixed: false,
  },
  matchRun: {
    strategy: 'exhaustive', matcher: 'bruteforce', nPairs: 8128,
    accepted: 647, weak: 0, rejected: 15, skipped: 20, gated: 7446,
    inliers: 145289, meanInlierRatio: 0.85, subsetGateActive: true, resolvedRansacPx: 2.53,
    settings: { ratioThreshold: 0.75, minInlierRatio: 0.15, crossCheck: true },
  },
  summary: {
    ...INPUT.summary,
    config: { reprjThresholdDetectPx: 4, baIterations: 30, refineIntrinsics: 'auto' },
    gates: {
      detectScaleFactor: 2.53, medianScale: 0.395, clamped: false, mixed: false,
      reprjThresholdPx: 7.6, filterMaxReprojPx: 10.14,
    },
    initPair: {
      nameA: 'P1180215', nameB: 'P1180321', angleDeg: 2.68, inliers: 812, points: 640,
      score: 91.4, degree: 21, readyViews: 23, candidatesScored: 24,
      runnerUp: { pair: 'P1180211 ↔ P1180210', score: 74.2, parallaxDeg: 5.21 },
    },
    attempts: {
      retryCap: 4, retriesRun: 0, winner: 0,
      seeds: [{ attempt: 0, pair: 'P1180215 ↔ P1180321', cameras: 122, points: 20953, kept: true }],
    },
    selfCal: {
      requested: 'auto', resolved: 'f,k1', staged: true,
      passes: [{ pass: 1, mode: 'f,k1', reducedReason: null },
        { pass: 2, mode: 'f', reducedReason: '2-view-dominated tracks' }],
    },
    intrinsics: [{ sensorId: 's1', label: 'Canon', fxNominal: 2389.3, fxFinal: 2565.9, deltaPct: 7.39, source: 'exif' }],
    selfCalDistortion: [{ sensorId: 's1', k1: -0.0251, k2: 0, k3: 0, fitRmsPx: 0.153 }],
    cycleFilter: {
      aborted: true, candidates: 647, triangles: 2010, medianTriErrDeg: 42.3,
      effErrDeg: 30, dropped: 0, readmitted: 0, bridgeProtected: 0, remainingPairs: 647,
    },
    secondaryRecovery: {
      jobs: 1, merged: [],
      separate: [{ name: 'Secondary sparse 1', cameras: 20, points: 6382, sharedCameras: 12, reason: 'position RMS 14.4%' }],
    },
    timings: { init: 4200, register: 61000, bundle: 18000, totalMs: 96000 },
  },
  depthSummary: {
    nMaps: 122, backend: 'gpu→wasm', gpuFallbacks: 1,
    settings: { quality: 'medium', maxDim: 768, maxSources: 6, iterations: 3, geomConsistency: true },
    medianMsPerImage: 40000, totalMs: 4880000, medianCoveragePct: 82.4, medianCostMedian: 0.15,
    geomFilterMs: 31000, geomFilterMedianKeptPct: 74.2, geomFilterMinKeptPct: 0.4,
    geomFilterMarginalMaps: 2, projectedPeakBytes: 1943011000, budgetBytes: 12884901888,
  },
  verdict: {
    level: 'yellow',
    headline: '122 of 128 images registered',
    findings: [{ level: 'yellow', code: 'depth-coverage', title: 'Depth coverage 49%', fix: 'Add overlap' }],
  },
  fingerprints: { algorithm: 'fnv1a32', features: 'fnv1a32:12345678', matches: 'fnv1a32:abcdef01' },
}

describe('buildProjectDigest — baseline record', () => {
  it('carries run config per stage, and nulls a stage with no record', () => {
    const d = buildProjectDigest(B4)
    expect(d.config.detect).toMatchObject({ detector: 'sift', maxDim: 2400, maxDimMode: 'absolute' })
    expect(d.config.match).toMatchObject({ strategy: 'exhaustive', pairs: 8128, ratioThreshold: 0.75 })
    expect(d.config.sparse).toMatchObject({ refineIntrinsics: 'auto' })
    expect(d.config.dense).toMatchObject({ quality: 'medium' })
    expect(buildProjectDigest(INPUT).config).toEqual({ detect: null, match: null, sparse: null, dense: null })
  })

  it('carries the seed decision, gates, self-cal and cycle-filter records', () => {
    const d = buildProjectDigest(B4).diagnostics
    expect(d.seed).toMatchObject({ nameA: 'P1180215', readyViews: 23 })
    expect(d.attempts.retriesRun).toBe(0)
    expect(d.gates.detectScaleFactor).toBeCloseTo(2.53)
    expect(d.selfCal.passes).toHaveLength(2)
    expect(d.intrinsics[0]).toMatchObject({ fxNominal: 2389.3, fxFinal: 2565.9 })
    expect(d.cycleFilter.aborted).toBe(true)
    expect(d.secondaryRecovery.separate[0].cameras).toBe(20)
    expect(d.fingerprints.matches).toBe('fnv1a32:abcdef01')
    expect(d.matchGates).toMatchObject({ gated: 7446, subsetGateActive: true })
    expect(d.timings.totalMs).toBe(96000)
  })

  it('diagnostics are null-but-present when the sparse summary predates them', () => {
    const d = buildProjectDigest(INPUT).diagnostics
    expect(d.seed).toBeNull()
    expect(d.gates).toBeNull()
    expect(d.intrinsics).toEqual([])
  })
})

describe('digestToMarkdown — baseline record', () => {
  const md = digestToMarkdown(buildProjectDigest(B4))

  it('states the config of every stage that has one', () => {
    expect(md).toContain('## Run config')
    expect(md).toContain('**Detect**: sift · 128 image(s)')
    expect(md).toContain('maxDim=2400')
    expect(md).toContain('**Match**: exhaustive · bruteforce')
  })

  it('names the seed, its runner-up, and whether a retry was needed', () => {
    expect(md).toContain('**Seed**: P1180215 ↔ P1180321')
    expect(md).toContain('runner-up: P1180211 ↔ P1180210')
    expect(md).toContain('(first seed, no retry)')
  })

  it('reports the fx trajectory with its delta', () => {
    expect(md).toContain('2389.3 → 2565.9 (+7.4%)')
  })

  it('reports the resolved pixel gates and the match gate tally', () => {
    expect(md).toContain('**Reprojection gates**: ×2.53')
    expect(md).toContain('7446 subset-gated')
  })

  it('reports the cycle filter skipping above its ceiling', () => {
    expect(md).toContain('SKIPPED (above sanity ceiling)')
    expect(md).toContain('42.3°')
  })

  it('reports separate secondary models and reproducibility fingerprints', () => {
    expect(md).toContain('1 kept separate')
    expect(md).toContain('Secondary sparse 1: 20 cams / 6382 pts')
    expect(md).toContain('features fnv1a32:12345678')
  })

  it('reports Stage A backend, throughput and cross-view filter cost', () => {
    expect(md).toContain('122 map(s) on gpu→wasm (1 GPU fallback(s))')
    expect(md).toContain('median 40.0s/image')
    expect(md).toContain('Cross-view filter: 31.0s')
    expect(md).toContain('projected peak 1.8 GB')
  })

  it('leads with the verdict and its findings', () => {
    expect(md.indexOf('## Verdict')).toBeLessThan(md.indexOf('## Health'))
    expect(md).toContain('- [yellow] Depth coverage 49% → Add overlap')
  })

  it('omits the config block entirely when nothing is known', () => {
    expect(digestToMarkdown(buildProjectDigest(INPUT))).not.toContain('## Run config')
  })
})

// ── Run-shape observations (2026-08-18) ────────────────────────────────────────
// Three figures that decided a real diagnosis but were previously either unrecorded
// or split across sections the reader had to join by hand. The digest is the run's
// *record*, so unlike the verdict's contributing-cause rules these print
// unconditionally — including when the news is good (0 degenerate, tight gate).
// Modelled on the DJI run: 5472px sensor detected at 2400 (×2.28), cap saturated,
// planar nadir geometry, and a track filter well above the observed residuals.
const DJI = {
  ...B4,
  snapshot: { reproj: { median: 0.86, p95: 4.0, n: 800000 } },
  detect: {
    detector: 'sift', images: 127, maxDim: 2400, maxDimMode: 'absolute',
    maxKeypoints: 10000, contrastThreshold: 0.01, tiling: 'off',
    medianKeypoints: 10000, medianDetectScale: 0.4386, kpCapHitPct: 100, mixed: false,
  },
  matchRun: {
    ...B4.matchRun, nPairs: 779, accepted: 779, rejected: 0, skipped: 0, gated: 0,
    subsetGateActive: false, meanInlierRatio: 0.98, degenerate: 623, degenerateOf: 779,
  },
  summary: {
    ...B4.summary,
    gates: {
      detectScaleFactor: 2.28, medianScale: 0.4386, clamped: false, mixed: false,
      reprjThresholdPx: 9.12, filterMaxReprojPx: 9.12,
    },
  },
}

describe('digestToMarkdown — run-shape observations', () => {
  const md = digestToMarkdown(buildProjectDigest(DJI))

  it('flags a saturated keypoint cap in the detect config', () => {
    expect(md).toContain('100% of images at the keypoint cap ⚠')
  })

  it('does not flag a cap that most images stayed under', () => {
    const ok = digestToMarkdown(buildProjectDigest({
      ...DJI, detect: { ...DJI.detect, kpCapHitPct: 12 },
    }))
    expect(ok).toContain('12% of images at the keypoint cap')
    expect(ok).not.toContain('keypoint cap ⚠')
  })

  it('puts the resolved gate next to the residuals it was applied to', () => {
    // fmtNum prints integers bare, module-wide — 4.0 renders as "4px", not "4.00px".
    expect(md).toContain('vs observed p95 4px → 2.3× headroom ⚠ the track filter is effectively inactive')
  })

  it('reports headroom without the warning when the gate actually bites', () => {
    const tight = digestToMarkdown(buildProjectDigest({
      ...DJI,
      summary: { ...DJI.summary, gates: { ...DJI.summary.gates, filterMaxReprojPx: 4.4 } },
    }))
    expect(tight).toContain('1.1× headroom')
    expect(tight).not.toContain('effectively inactive')
  })

  it('reports the H/F-degenerate share of accepted pairs', () => {
    expect(md).toContain('H/F-degenerate (planar / pure rotation): 623/779 accepted (80%)')
  })

  it('reports a zero degenerate share rather than omitting it', () => {
    const clean = digestToMarkdown(buildProjectDigest({
      ...DJI, matchRun: { ...DJI.matchRun, degenerate: 0 },
    }))
    expect(clean).toContain('0/779 accepted (0%)')
  })

  // Older runs recorded none of these three. Absent must stay absent — a digest that
  // printed "0%" for an unmeasured share would be claiming a measurement.
  it('omits every new line when the run predates the measurements', () => {
    const old = digestToMarkdown(buildProjectDigest(B4))
    expect(old).not.toContain('keypoint cap')
    expect(old).not.toContain('headroom')
    expect(old).not.toContain('H/F-degenerate')
  })
})

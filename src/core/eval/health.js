// Pure project-health rollup for the Quality Report hub Overview (PLAN-eval-quality-hub
// WS1). No Vue/Pinia/DOM — the store assembles a plain `snapshot` (each field
// nullable, derived from the cloud so it works on an imported COLMAP model with no
// run summary) and this turns it into a flat list of status rows the Overview
// renders and links from.
//
// Every warn/bad threshold lives in the ONE table below with a rationale comment, so
// the sections and the overview colour by the same numbers and there are no scattered
// magic constants (that was the pre-hub complaint). A tile that colours by tone shows
// its threshold in the hint ("warn > 1.0 px").

// dir semantics:
//   'high'    → bigger is better; value below warn/bad is warn/bad (coverage, %reg)
//   'low'     → smaller is better; value at/above warn/bad is warn/bad (reproj px, RMSE)
//   'low-abs' → |value| smaller is better (a signed delta: focal Δ%, bias)
export const EVAL_THRESHOLDS = {
  // A survey that dropped >10% of images has a connectivity/overlap problem worth a
  // look; <70% registered is usually a broken block.
  registeredPct:    { warn: 90,   bad: 70,   dir: 'high' },
  // Sub-pixel median reprojection is the healthy-BA norm; >1px hints at bad
  // intrinsics or outlier tracks, >2px is a poor solve.
  reprojMedianPx:   { warn: 1.0,  bad: 2.0,  dir: 'low' },
  // Tie points seen by ≥3 views are the well-constrained ones; a block dominated by
  // 2-view points is geometrically thin.
  track3ViewPct:    { warn: 60,   bad: 40,   dir: 'high' },
  // A split match graph (>1 component) cannot register as one block — anything above
  // a single component is a warning regardless of size.
  graphComponents:  { warn: 2,    bad: 999,  dir: 'low' },
  // Dense-warp approximation RMS: sparse applies a sequence of exact self-cal folds,
  // while dense currently receives one composed radial bag. This measures that
  // representation loss, not whether BA calibrated the lens correctly. The R1–R4
  // baselines all landed at 0.16–0.20px (including the healthy 128-camera result), so
  // the former 0.05/0.20 bounds produced a warning on every real run. Keep sub-quarter-
  // pixel approximation error healthy; ≥0.5px is materially large for dense warping.
  selfCalFitRmsPx:  { warn: 0.25, bad: 0.5,  dir: 'low' },
  // GCP georeference residual (CRS units, usually m). Aerial survey grade is
  // sub-metre; several metres means a bad fit or mismarked GCPs.
  gcpRmse:          { warn: 1.0,  bad: 3.0,  dir: 'low' },
  // Camera-pose residual vs imported EXIF/GNSS positions. EXIF is coarse, so the
  // bar is looser than GCPs.
  poseRmse:         { warn: 2.0,  bad: 10.0, dir: 'low' },
  // Independent vertical check: DEM height at each GCP vs surveyed Z.
  demDzRmse:        { warn: 1.0,  bad: 3.0,  dir: 'low' },
  // Per-map valid-depth coverage. A dense stage keeping <50% of pixels is thin;
  // <25% usually means bad intrinsics or too few sources.
  depthCoveragePct: { warn: 50,   bad: 25,   dir: 'high' },
  // Refined vs nominal focal disagreement — a large gap flags a wrong sensor size /
  // EXIF focal (self-cal absorbed it, but the nominal was wrong).
  focalDeltaPct:    { warn: 5,    bad: 15,   dir: 'low-abs' },
}

// Classify a value against a threshold row. null value → 'missing' (prerequisite not
// met); otherwise 'ok' | 'warn' | 'bad'.
export function classify(value, thr) {
  if (value == null || !thr) return value == null ? 'missing' : 'ok'
  const v = thr.dir === 'low-abs' ? Math.abs(value) : value
  if (thr.dir === 'high') {
    if (v < thr.bad) return 'bad'
    if (v < thr.warn) return 'warn'
    return 'ok'
  }
  if (v >= thr.bad) return 'bad'
  if (v >= thr.warn) return 'warn'
  return 'ok'
}

// A short "warn > X" caption from a threshold row, for the hint line.
export function thresholdHint(thr, unit = '') {
  if (!thr) return ''
  const u = unit ? ` ${unit}` : ''
  if (thr.dir === 'high') return `warn < ${thr.warn}${u}`
  if (thr.dir === 'low-abs') return `warn > ±${thr.warn}${u}`
  return `warn > ${thr.warn}${u}`
}

// RMS over the finite values of `sel(row)` across `rows`, or null when none.
function rmse(rows, sel) {
  const vals = (rows || []).map(sel).filter((v) => v != null && Number.isFinite(v))
  if (!vals.length) return null
  return Math.sqrt(vals.reduce((a, v) => a + v * v, 0) / vals.length)
}

// Build the Overview status rows from a plain snapshot. Every field is nullable; a
// missing prerequisite yields a `missing` row (rendered greyed with the prerequisite
// as hint) rather than vanishing — the overview is the discoverability surface.
//
// snapshot: {
//   imageCount, registeredCount,
//   reproj:   { median, p95, max, n } | null,           // reprojectionStats over the cloud
//   histogram:[{ views, count, pct }] | null,           // trackLengthHistogram
//   graph:    { components:[[id,…],…], isolated:[id] } | null,
//   selfCal:  [{ sensorId, fitRmsPx }] | null,          // summary.selfCalDistortion
//   focalDeltas: [number|null] | null,                  // per-sensor Δ focal %
//   gcpReport:  [{ dTotal, role }] | null,              // enabled controls + checkpoints
//   poseReport: [{ dTotal }] | null,
//   demCheck:   [{ dz }] | null,
//   depth:    { coveragePct, mapCount } | null,         // mean per-map valid %
//   crsUnit:  'm' (georef CRS unit label),
// }
// → rows: [{ id, section, label, value, unit, status, hint }]
export function projectHealth(snapshot = {}) {
  const s = snapshot
  const rows = []
  const unit = s.crsUnit || 'm'

  const push = (id, section, label, value, u, thr, opts = {}) => {
    const status = opts.status ?? classify(value, thr)
    rows.push({
      id, section, label,
      value: value == null ? null : value,
      unit: u || '',
      status,
      hint: status === 'missing' ? (opts.missingHint || 'no data') : (opts.hint ?? thresholdHint(thr, u)),
    })
  }

  // Registered %
  const regPct = s.imageCount ? (s.registeredCount / s.imageCount) * 100 : null
  push('registered', 'sparse', 'Registered images', regPct, '%',
    EVAL_THRESHOLDS.registeredPct,
    { hint: s.imageCount ? `${s.registeredCount} / ${s.imageCount}` : 'no images',
      missingHint: 'no images' })

  // Reprojection median
  push('reproj', 'sparse', 'Reprojection median', s.reproj?.median ?? null, 'px',
    EVAL_THRESHOLDS.reprojMedianPx, { missingHint: 'run reconstruction first' })

  // ≥3-view track %
  let pct3 = null
  if (s.histogram?.length) {
    const total = s.histogram.reduce((a, b) => a + b.count, 0)
    const many = s.histogram
      .filter((b) => b.views === '8+' || Number(b.views) >= 3)
      .reduce((a, b) => a + b.count, 0)
    pct3 = total ? (many / total) * 100 : null
  }
  push('tracks', 'sparse', '≥3-view tracks', pct3, '%',
    EVAL_THRESHOLDS.track3ViewPct, { missingHint: 'run reconstruction first' })

  // Graph components
  const nComp = s.graph?.components?.length ?? null
  const isolated = s.graph?.isolated?.length ?? 0
  push('graph', 'matching', 'Match-graph components', nComp, '',
    EVAL_THRESHOLDS.graphComponents,
    { missingHint: 'run matching first',
      hint: nComp == null ? undefined
        : (nComp > 1 ? `split — ${isolated} isolated` : 'connected') })

  // Dense-warp approximation RMS (worst sensor).
  let fitRms = null
  if (s.selfCal?.length) {
    fitRms = Math.max(...s.selfCal.map((d) => d.fitRmsPx ?? 0))
  }
  push('selfcal', 'calibration', 'Self-cal warp fit RMS', fitRms, 'px',
    EVAL_THRESHOLDS.selfCalFitRmsPx, { missingHint: 'self-cal was off / no summary' })

  // Focal delta (worst sensor, absolute %)
  let focalPct = null
  if (s.focalDeltas?.length) {
    const finite = s.focalDeltas.filter((v) => v != null && Number.isFinite(v))
    if (finite.length) focalPct = finite.reduce((m, v) => (Math.abs(v) > Math.abs(m) ? v : m), 0)
  }
  push('focal', 'calibration', 'Focal Δ vs nominal', focalPct, '%',
    EVAL_THRESHOLDS.focalDeltaPct, { missingHint: 'no registered sensors' })

  // Prefer genuinely independent checkpoints. Fall back to control fit residuals,
  // but label that weaker quantity honestly instead of blending the two populations.
  const checks = s.gcpReport?.filter((r) => r.role === 'check' && r.dTotal != null) ?? []
  const controls = s.gcpReport?.filter((r) => r.role !== 'check' && r.dTotal != null) ?? []
  const gcpRmse = rmse(checks.length ? checks : controls, (r) => r.dTotal)
  push('gcp', 'accuracy', checks.length ? 'Checkpoint RMSE' : 'Control fit RMSE', gcpRmse, unit,
    EVAL_THRESHOLDS.gcpRmse, {
      missingHint: 'need triangulated GCPs or checkpoints',
      hint: checks.length ? 'independent accuracy' : (controls.length ? 'no valid checkpoints — not independent' : undefined),
    })

  // Pose RMSE
  const poseRmse = s.poseReport ? rmse(s.poseReport, (r) => r.dTotal) : null
  push('pose', 'accuracy', 'Pose RMSE', poseRmse, unit,
    EVAL_THRESHOLDS.poseRmse, { missingHint: 'need imported poses + georef' })

  // DEM vs GCP ΔZ RMSE
  const demRmse = s.demCheck ? rmse(s.demCheck, (r) => r.dz) : null
  push('dem', 'accuracy', 'DEM ΔZ RMSE', demRmse, unit,
    EVAL_THRESHOLDS.demDzRmse, { missingHint: 'build a DEM + GCPs first' })

  // Depth-map coverage
  push('depth', 'dense', 'Depth-map coverage', s.depth?.coveragePct ?? null, '%',
    EVAL_THRESHOLDS.depthCoveragePct, { missingHint: 'build depth maps first' })

  return rows
}

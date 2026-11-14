// Positional accuracy at checkpoints after the ASPRS Positional Accuracy Standards for
// Digital Geospatial Data, Edition 2 (2023): the statistics and the accuracy class a
// surveyor reports, from the checkpoints' residuals and their declared survey accuracy.
// Pure.
//
// - Per axis: mean error, standard deviation (n − 1) and RMSE (n) of the residuals
//   (product − checkpoint).
// - RMSE_H = √(RMSE_X² + RMSE_Y²); RMSE_3D = √(RMSE_H² + RMSE_V²).
// - Edition 2 counts the checkpoints' own survey error into the product's accuracy:
//   RMSE = √(RMSE₁² + RMSE₂²), RMSE₁ the fit to the checkpoints, RMSE₂ the checkpoint
//   survey's. RMSE₂ comes from each checkpoint's declared 1σ per axis
//   (RMSE_X₂ = √(mean σx²), likewise Y and Z; RMSE_H₂ = √(RMSE_X₂² + RMSE_Y₂²)).
// - A data set meets an accuracy class of X when its RMSE ≤ X; the class is the
//   project's, so the smallest one met is the RMSE itself.
// - The standard asks for at least 30 checkpoints, recommends a mean error under 25 % of
//   the target RMSE, and treats a residual over 3 × the target RMSE in any axis as a
//   blunder. Without a target, the measured RMSE stands in for it here (said so in the
//   report).

export const ASPRS_MIN_CHECKPOINTS = 30
export const ASPRS_MEAN_ERROR_SHARE = 0.25
export const ASPRS_BLUNDER_FACTOR = 3

const finite = (v) => typeof v === 'number' && Number.isFinite(v)

// Mean, standard deviation (n − 1) and RMSE of a list of residuals; nulls without data.
export function axisStats(values) {
  const v = values.filter(finite)
  const n = v.length
  if (!n) return { n: 0, mean: null, sd: null, rmse: null }
  const mean = v.reduce((a, b) => a + b, 0) / n
  const sd = n > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)) : null
  const rmse = Math.sqrt(v.reduce((a, b) => a + b * b, 0) / n)
  return { n, mean, sd, rmse }
}

// √(mean σ²) over declared accuracies; null when any is missing.
function surveyRmse(sigmas) {
  if (!sigmas.length || !sigmas.every((s) => finite(s) && s > 0)) return null
  return Math.sqrt(sigmas.reduce((a, s) => a + s * s, 0) / sigmas.length)
}

const combine = (a, b) => (a == null ? null : b == null ? a : Math.hypot(a, b))

// checks: [{ name, dx, dy, dz, sx, sy, sz }] — residuals (product − checkpoint) and the
// checkpoint's declared 1σ per axis, all in the CRS's linear unit; a missing dz (a 2-D
// checkpoint) leaves it out of the vertical figures.
// → { n, nH, nV, x, y, z (axisStats), h, v, d3: { fit, survey, product },
//     surveyDeclared, enoughPoints, meanErrorFlags: ['x'|'y'|'z'], blunders: [{ name, axis, value }] }
export function asprsAccuracy(checks = []) {
  const pts = checks.filter((c) => finite(c.dx) && finite(c.dy))
  const vpts = checks.filter((c) => finite(c.dz))
  const x = axisStats(pts.map((c) => c.dx))
  const y = axisStats(pts.map((c) => c.dy))
  const z = axisStats(vpts.map((c) => c.dz))

  const hFit = x.rmse == null ? null : Math.hypot(x.rmse, y.rmse)
  const sx = surveyRmse(pts.map((c) => c.sx))
  const sy = surveyRmse(pts.map((c) => c.sy))
  const hSurvey = sx == null || sy == null ? null : Math.hypot(sx, sy)
  const vSurvey = surveyRmse(vpts.map((c) => c.sz))
  const h = { fit: hFit, survey: hSurvey, product: combine(hFit, hSurvey) }
  const v = { fit: z.rmse, survey: vSurvey, product: combine(z.rmse, vSurvey) }
  const d3 =
    h.product != null && v.product != null
      ? { fit: Math.hypot(h.fit, v.fit), survey: null, product: Math.hypot(h.product, v.product) }
      : { fit: null, survey: null, product: null }

  // The standard's two screens, with the measured RMSE standing in for the target.
  const meanErrorFlags = []
  for (const [axis, s] of [
    ['x', x],
    ['y', y],
    ['z', z],
  ]) {
    if (s.n > 1 && s.rmse > 0 && Math.abs(s.mean) > ASPRS_MEAN_ERROR_SHARE * s.rmse) meanErrorFlags.push(axis)
  }
  const blunders = []
  for (const c of checks) {
    for (const [axis, value, s] of [
      ['x', c.dx, x],
      ['y', c.dy, y],
      ['z', c.dz, z],
    ]) {
      if (finite(value) && s.rmse > 0 && s.n > 2 && Math.abs(value) > ASPRS_BLUNDER_FACTOR * s.rmse)
        blunders.push({ name: c.name, axis, value })
    }
  }

  return {
    n: checks.length,
    nH: pts.length,
    nV: vpts.length,
    x,
    y,
    z,
    h,
    v,
    d3,
    surveyDeclared: { h: hSurvey != null, v: vSurvey != null },
    enoughPoints: { h: pts.length >= ASPRS_MIN_CHECKPOINTS, v: vpts.length >= ASPRS_MIN_CHECKPOINTS },
    meanErrorFlags,
    blunders,
  }
}

// The accuracy statement for the report, worded only as strongly as the test allows:
// the standard's "tested to meet" sentence needs ≥ 30 checkpoints and their declared
// survey accuracy; otherwise the figures are reported as measured. `fmt(v)` formats a
// length in the report's unit ("5.4 cm"). → string[] (one sentence per component).
export function asprsStatement(a, fmt) {
  const out = []
  const part = (label, cls, ok, n, declared) => {
    if (cls == null) return
    if (ok && declared) {
      out.push(
        `This data set was tested to meet the ASPRS Positional Accuracy Standards for Digital ` +
          `Geospatial Data, Edition 2 (2023) for a ${fmt(cls)} ${label} positional accuracy class.`,
      )
    } else {
      const why = [
        !ok
          ? `${n} checkpoint${n === 1 ? '' : 's'}, fewer than the ${ASPRS_MIN_CHECKPOINTS} the standard asks for`
          : null,
        !declared ? 'the checkpoints declare no survey accuracy, so RMSE₂ is left out' : null,
      ].filter(Boolean)
      out.push(`${label}: ${fmt(cls)} at the checkpoints (${why.join('; ')}), not a compliant ASPRS statement.`)
    }
  }
  part('RMSE_H horizontal', a.h.product, a.enoughPoints.h, a.nH, a.surveyDeclared.h)
  part('RMSE_V vertical', a.v.product, a.enoughPoints.v, a.nV, a.surveyDeclared.v)
  return out
}

// The checkpoints of a GCP accuracy report as asprsAccuracy takes them: the enabled
// GCPs whose role is 'check' and that have a residual, with their declared 1σ.
// rows: [{ gcpId | id, name, role, dx, dy, dz }]; gcps: the GCP records (accuracyX/Y/Z,
// enabled), in the same CRS as the residuals.
export function checkpointResiduals(rows = [], gcps = []) {
  const byId = new Map(gcps.map((g) => [g.id, g]))
  return rows
    .map((r) => ({ r, g: byId.get(r.gcpId ?? r.id) }))
    .filter(({ r, g }) => g && g.enabled !== false && (r.role ?? g.role) === 'check' && finite(r.dx))
    .map(({ r, g }) => ({
      name: r.name ?? g.name,
      dx: r.dx,
      dy: r.dy,
      dz: r.dz,
      sx: g.accuracyX,
      sy: g.accuracyY,
      sz: g.accuracyZ,
    }))
}

// Whether a CRS unit is a length the standard's figures can be stated in.
export const asprsUnitOk = (unit) => unit === 'm' || unit === 'ft' || unit === 'US-ft'

// A length in the report's unit: centimetres for a metre CRS, else the CRS's foot.
export function asprsLength(v, unit) {
  if (v == null) return '—'
  return unit === 'm' ? `${(v * 100).toFixed(1)} cm` : `${v.toFixed(3)} ${unit}`
}

// The Quality Report export's section (core/products/report.js shape) for checkpoints
// `checks` (checkpointResiduals) in CRS unit `unit`; null without checkpoints or without a
// linear unit (the standard's figures are lengths).
export function asprsReportSection(checks, unit) {
  if (!checks.length || !asprsUnitOk(unit)) return null
  const a = asprsAccuracy(checks)
  const len = (v) => asprsLength(v, unit)
  const row = (component, n, st, fit, survey, product) => ({
    component,
    n,
    mean: st ? len(st.mean) : '—',
    sd: st ? len(st.sd) : '—',
    fit: len(fit),
    survey: len(survey),
    rmse: len(product),
  })
  const notes = [
    ...asprsStatement(a, len),
    'Residuals are the checkpoints triangulated in the adjusted model minus their surveyed ' +
      "coordinates: the accuracy of the photogrammetric adjustment. RMSE₂ is the checkpoints' " +
      'own survey accuracy, from their declared 1σ; RMSE = √(RMSE₁² + RMSE₂²).',
  ]
  const axisName = { x: 'X', y: 'Y', z: 'Z' }
  if (a.meanErrorFlags.length)
    notes.push(
      `Mean error over 25 % of the RMSE in ${a.meanErrorFlags.map((k) => axisName[k]).join(', ')}: ` +
        'a systematic shift the standard asks to remove first (it recommends under 25 % of the target RMSE).',
    )
  if (a.blunders.length)
    notes.push(
      'Over 3 × the RMSE (blunders by the standard): ' +
        a.blunders.map((b) => `${b.name} ${axisName[b.axis]} ${len(b.value)}`).join(', ') +
        '.',
    )
  return {
    title: 'Accuracy at the checkpoints (ASPRS 2023)',
    tiles: [
      { label: 'RMSE_H', value: len(a.h.product) },
      { label: 'RMSE_V', value: len(a.v.product) },
      { label: 'RMSE_3D', value: len(a.d3.product) },
      {
        label: 'Checkpoints',
        value: String(a.nH),
        tone: a.enoughPoints.h ? undefined : 'warn',
        hint: a.enoughPoints.h ? undefined : 'The standard asks for at least 30',
      },
    ],
    columns: [
      { key: 'component', label: 'Component' },
      { key: 'n', label: 'n', align: 'right' },
      { key: 'mean', label: 'Mean error', align: 'right' },
      { key: 'sd', label: 'Std dev', align: 'right' },
      { key: 'fit', label: 'RMSE₁ (fit)', align: 'right' },
      { key: 'survey', label: 'RMSE₂ (survey)', align: 'right' },
      { key: 'rmse', label: 'RMSE', align: 'right' },
    ],
    rows: [
      row('X (east)', a.nH, a.x, a.x.rmse, null, null),
      row('Y (north)', a.nH, a.y, a.y.rmse, null, null),
      row('Horizontal', a.nH, null, a.h.fit, a.h.survey, a.h.product),
      row('Vertical', a.nV, a.z, a.v.fit, a.v.survey, a.v.product),
      row('3D', Math.min(a.nH, a.nV), null, a.d3.fit, null, a.d3.product),
    ],
    note: notes.join(' '),
  }
}

// The DEM at the checkpoints, as asprsAccuracy takes them: the enabled checkpoints the DEM
// covers, its height (bilinear) minus the surveyed one, with the declared σz.
// demRows: core/eval/demCheck.js sampleDemAtGcps ([{ gcpId, name, dz }], dz null off the
// DEM or on nodata); gcps: the GCP records. → { checks, off } (`off`: checkpoints the DEM
// does not cover, left out).
export function demCheckpointResiduals(demRows = [], gcps = []) {
  const byId = new Map(gcps.map((g) => [g.id, g]))
  const rows = demRows
    .map((r) => ({ r, g: byId.get(r.gcpId) }))
    .filter(({ g }) => g && g.enabled !== false && g.role === 'check')
  return {
    checks: rows
      .filter(({ r }) => finite(r.dz))
      .map(({ r, g }) => ({ name: r.name ?? g.name, dx: null, dy: null, dz: r.dz, sz: g.accuracyZ })),
    off: rows.filter(({ r }) => !finite(r.dz)).length,
  }
}

// The Quality Report export's section for the DEM's vertical accuracy at the checkpoints:
// the standard's non-vegetated vertical accuracy (NVA), which Edition 2 tests on
// checkpoints in open ground. Unlike the adjustment's section, this checks the product: the
// DEM a user exports. null without a checkpoint on the DEM or without a linear unit.
export function asprsDemSection(demRows, gcps, unit) {
  const { checks, off } = demCheckpointResiduals(demRows, gcps)
  if (!checks.length || !asprsUnitOk(unit)) return null
  const a = asprsAccuracy(checks)
  const len = (v) => asprsLength(v, unit)
  const notes = [
    ...asprsStatement(a, len).map((s) => s.replace('RMSE_V vertical', 'RMSE_V (NVA) vertical')),
    "Residuals are the DEM's height at each checkpoint (bilinear) minus its surveyed height: " +
      'the accuracy of the elevation product itself. The standard tests NVA on checkpoints in ' +
      'open, non-vegetated ground; a checkpoint under vegetation or on a structure measures ' +
      'something else.',
  ]
  if (off) notes.push(`${off} checkpoint${off === 1 ? '' : 's'} outside the DEM or on a gap, left out.`)
  if (a.meanErrorFlags.includes('z'))
    notes.push(
      'Mean error over 25 % of the RMSE: a vertical shift between the DEM and the checkpoints ' +
        'the standard asks to remove first.',
    )
  const bl = a.blunders.filter((b) => b.axis === 'z')
  if (bl.length)
    notes.push(
      'Over 3 × the RMSE (blunders by the standard): ' + bl.map((b) => `${b.name} ${len(b.value)}`).join(', ') + '.',
    )
  return {
    title: 'DEM accuracy at the checkpoints (ASPRS 2023, NVA)',
    tiles: [
      { label: 'RMSE_V (NVA)', value: len(a.v.product) },
      { label: 'Mean error', value: len(a.z.mean), tone: a.meanErrorFlags.includes('z') ? 'warn' : undefined },
      {
        label: 'Checkpoints',
        value: String(a.nV),
        tone: a.enoughPoints.v ? undefined : 'warn',
        hint: a.enoughPoints.v ? undefined : 'The standard asks for at least 30',
      },
    ],
    columns: [
      { key: 'component', label: 'Component' },
      { key: 'n', label: 'n', align: 'right' },
      { key: 'mean', label: 'Mean error', align: 'right' },
      { key: 'sd', label: 'Std dev', align: 'right' },
      { key: 'fit', label: 'RMSE₁ (DEM)', align: 'right' },
      { key: 'survey', label: 'RMSE₂ (survey)', align: 'right' },
      { key: 'rmse', label: 'RMSE', align: 'right' },
    ],
    rows: [
      {
        component: 'Vertical (NVA)',
        n: a.nV,
        mean: len(a.z.mean),
        sd: len(a.z.sd),
        fit: len(a.v.fit),
        survey: len(a.v.survey),
        rmse: len(a.v.product),
      },
    ],
    note: notes.join(' '),
  }
}

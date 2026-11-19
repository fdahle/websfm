// How accurate the georeferenced model is, kept after every fit, so a change can be
// compared with the one before it (Evaluate ▸ Accuracy ▸ Since the last fit, and the
// log line each Georeference writes). stores/reconstruction/georeferencing.js records one
// after every georeference; the project keeps the last ACCURACY_HISTORY_MAX.
//
// Only numbers that can say "better" are compared:
// - checkpoints: never in the fit, so their error is independent;
// - leave-one-out of the control points (four or more: each predicted by a fit without
//   it, core gcpAccuracyReport `loo*`); a control point's own residual always shrinks
//   when it is used, so it is never compared;
// - the camera positions, only when the fit was made to the GCPs: fitted to the cameras,
//   their residual is the fit itself.
// A metric compares only when it is measured on the same points both times; a changed
// set is reported as changed, not as better or worse.
//
// Pure: plain data in, plain data out.

export const ACCURACY_HISTORY_MAX = 20
// A change under this fraction of the value is "the same".
const SAME_FRACTION = 0.02

const rms = (vals) => (vals.length ? Math.sqrt(vals.reduce((s, v) => s + v * v, 0) / vals.length) : null)
// { n, h, v, ids }: horizontal and vertical RMSE over rows of { dx, dy, dz }.
function errorOf(rows, idOf) {
  if (!rows.length) return null
  return {
    n: rows.length,
    h: rms(rows.map((r) => Math.hypot(r.dx, r.dy))),
    v: rms(rows.map((r) => r.dz)),
    ids: rows.map(idOf).sort(),
  }
}
const finite3 = (a, b, c) => Number.isFinite(a) && Number.isFinite(b) && Number.isFinite(c)

/**
 * @param {{ report: object[], poseResiduals?: object[], method?: string|null,
 *   change?: string|null, at?: string }} input
 *   report: gcpAccuracyReport() rows; poseResiduals: poseResidualReport() rows; method:
 *   the fit's ('gcps' | 'poses' | 'dem-hold'); change: what changed the model since the
 *   last fit ("Optimize cameras: full lens"), if known
 * @returns {object} { at, method, change, controls: [{ id, name }], checks: [{ id, name }],
 *   checkpoints, loo, cameras ({ n, h, v, ids } or null), marksPx, independent }
 */
export function accuracySnapshot({ report = [], poseResiduals = [], method = null, change = null, at } = {}) {
  const controlRows = report.filter((r) => (r.role ?? 'control') === 'control' && r.dTotal != null)
  const checkRows = report.filter((r) => r.role === 'check' && finite3(r.dx, r.dy, r.dz))
  const looRows = controlRows
    .filter((r) => finite3(r.looDx, r.looDy, r.looDz))
    .map((r) => ({ gcpId: r.gcpId, dx: r.looDx, dy: r.looDy, dz: r.looDz }))
  const cameras =
    method === 'gcps'
      ? errorOf(
          poseResiduals.filter((r) => finite3(r.dx, r.dy, r.dz)),
          (r) => String(r.uuid ?? r.imageId ?? r.name),
        )
      : null
  const marks = report.flatMap((r) => (r.observations ?? []).map((o) => o.reprojPx).filter(Number.isFinite))
  const checkpoints = errorOf(checkRows, (r) => r.gcpId)
  const loo = looRows.length >= 4 ? errorOf(looRows, (r) => r.gcpId) : null
  return {
    at: at ?? new Date().toISOString(),
    method,
    change,
    controls: controlRows.map((r) => ({ id: r.gcpId, name: r.name })),
    checks: checkRows.map((r) => ({ id: r.gcpId, name: r.name })),
    checkpoints,
    loo,
    cameras,
    marksPx: rms(marks),
    independent: !!(checkpoints || loo || cameras),
  }
}

// The same accuracy as last time, so a refit that changed nothing adds no entry.
export function sameAccuracy(a, b) {
  if (!a || !b) return false
  const key = (s) =>
    JSON.stringify([
      s.method,
      s.controls.map((c) => c.id).sort(),
      s.checks.map((c) => c.id).sort(),
      ...['checkpoints', 'loo', 'cameras'].map((k) => (s[k] ? [s[k].n, s[k].h, s[k].v] : null)),
    ])
  return key(a) === key(b)
}

const METRICS = [
  { key: 'checkpoints', axis: 'h' },
  { key: 'checkpoints', axis: 'v' },
  { key: 'loo', axis: 'h' },
  { key: 'loo', axis: 'v' },
  { key: 'cameras', axis: 'h' },
  { key: 'cameras', axis: 'v' },
]

/**
 * The change from `prev` to `cur`: [{ key, axis, cur, prev, delta, verdict }], verdict
 * 'better' | 'worse' | 'same' | 'changed' (measured on other points: not comparable) |
 * 'new' | 'gone'; and which control points and checkpoints came or went.
 */
export function compareAccuracy(cur, prev) {
  const rows = []
  for (const { key, axis } of METRICS) {
    const c = cur?.[key],
      p = prev?.[key]
    if (!c && !p) continue
    const row = { key, axis, cur: c?.[axis] ?? null, prev: p?.[axis] ?? null, delta: null, verdict: 'same' }
    if (c && !p) row.verdict = 'new'
    else if (!c && p) row.verdict = 'gone'
    else if (JSON.stringify(c.ids) !== JSON.stringify(p.ids)) row.verdict = 'changed'
    else {
      row.delta = row.cur - row.prev
      if (Math.abs(row.delta) > SAME_FRACTION * Math.max(Math.abs(row.prev), 1e-9))
        row.verdict = row.delta < 0 ? 'better' : 'worse'
    }
    rows.push(row)
  }
  const diff = (a = [], b = []) => {
    const had = new Set(b.map((x) => x.id))
    return a.filter((x) => !had.has(x.id)).map((x) => x.name)
  }
  return {
    rows,
    controlsAdded: diff(cur?.controls, prev?.controls),
    controlsRemoved: diff(prev?.controls, cur?.controls),
    checksAdded: diff(cur?.checks, prev?.checks),
    checksRemoved: diff(prev?.checks, cur?.checks),
  }
}

// The history with `snap` added: unchanged accuracy adds nothing; the last
// ACCURACY_HISTORY_MAX are kept.
export function withSnapshot(history, snap) {
  const list = Array.isArray(history) ? history : []
  if (sameAccuracy(list.at(-1), snap)) return list
  return [...list, snap].slice(-ACCURACY_HISTORY_MAX)
}

// One line for the log: what the independent checks are now, and before.
//   "checkpoints (4) H 0.038 / V 0.047 m, was 0.052 / 0.061 m; …"
export function accuracyLogText(cur, prev, unit = 'm') {
  if (!cur?.independent)
    return 'no independent check: mark checkpoints, or use four or more control points for leave-one-out'
  const NAMES = { checkpoints: 'checkpoints', loo: 'control points left out in turn', cameras: 'camera positions' }
  const f = (v) => (v == null ? '—' : v.toFixed(3))
  const { rows } = compareAccuracy(cur, prev)
  return ['checkpoints', 'loo', 'cameras']
    .filter((k) => cur[k])
    .map((k) => {
      const s = cur[k]
      const h = rows.find((r) => r.key === k && r.axis === 'h'),
        v = rows.find((r) => r.key === k && r.axis === 'v')
      const was =
        h?.verdict === 'changed'
          ? ', measured on other points than before'
          : prev?.[k] && h?.prev != null
            ? `, was ${f(h.prev)} / ${f(v?.prev)} ${unit}`
            : ''
      return `${NAMES[k]} (${s.n.toLocaleString('en')}) H ${f(s.h)} / V ${f(s.v)} ${unit}${was}`
    })
    .join('; ')
}

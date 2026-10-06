// ── Interim bundle-adjustment acceptance (pure) ───────────────────────────────
// The crate's Levenberg–Marquardt descends a Huber-robustified cost (bundle.rs
// `robust_cost`, δ = 2.5 × median residual), but reports PLAIN RMS before and after.
// Judging a solve by plain RMS rejects correct solves: down-weighting outliers is
// exactly what a robust BA is for, and it lets those outliers drift further, so plain
// RMS can rise while the objective falls. Each rejection kept the pre-BA state — newly
// registered cameras unrefined, bad points in place — and on South Building the next
// interim BAs started from RMS 185 / 902 / 220 px (MAT-15/16).
//
// So compare both states under ONE robust cost: the Huber loss at a single δ taken
// from the pre-BA residuals (the crate re-derives δ per iteration; a fixed δ is what
// makes before and after comparable). The projection mirrors bundle.rs `project_full`
// (pinhole + radial k1..k3 on normalised coordinates). A projection behind or on the
// camera costs δ², as in the crate.

/**
 * @param {{R:number[][], t:number[]}} cam
 * @param {{fx:number, fy:number, cx:number, cy:number, k1?:number, k2?:number, k3?:number}} K
 * @param {{x:number, y:number, z:number}} p
 */
export function projectFull(cam, K, p) {
  const { R, t } = cam
  const xc = R[0][0] * p.x + R[0][1] * p.y + R[0][2] * p.z + t[0]
  const yc = R[1][0] * p.x + R[1][1] * p.y + R[1][2] * p.z + t[1]
  const zc = R[2][0] * p.x + R[2][1] * p.y + R[2][2] * p.z + t[2]
  if (Math.abs(zc) < 1e-9) return null
  const a = xc / zc, b = yc / zc
  const r2 = a * a + b * b, r4 = r2 * r2
  const d = 1 + (K.k1 ?? 0) * r2 + (K.k2 ?? 0) * r4 + (K.k3 ?? 0) * r4 * r2
  return { x: K.fx * a * d + K.cx, y: K.fy * b * d + K.cy }
}

function residuals(state, observations) {
  const out = new Float64Array(observations.length)
  for (let i = 0; i < observations.length; i++) {
    const o = observations[i]
    const q = projectFull(state.cams[o.camIdx], state.Ks[o.camIdx], state.points[o.ptIdx])
    out[i] = q ? Math.hypot(q.x - o.x, q.y - o.y) : NaN
  }
  return out
}

const huber = (e, d) => (Number.isNaN(e) ? d * d : e <= d ? e * e : 2 * d * e - d * d)

/**
 * Compare a pre- and post-BA state under one Huber cost.
 *
 * @param {object} o
 * @param {{cams:Array, Ks:Array, points:Array}} o.before
 * @param {{cams:Array, Ks:Array, points:Array}} o.after
 * @param {{camIdx:number, ptIdx:number, x:number, y:number}[]} o.observations
 * @returns {{ delta:number, before:number, after:number, improved:boolean }}
 *   `before`/`after` are RMS-equivalent (sqrt of mean Huber cost), in px.
 */
export function compareRobustCost({ before, after, observations }) {
  const eb = residuals(before, observations)
  const ea = residuals(after, observations)
  const finite = [...eb].filter((e) => Number.isFinite(e)).sort((x, y) => x - y)
  const med = finite.length ? finite[Math.floor(finite.length / 2)] : 1
  const delta = Math.max(1, 2.5 * med)
  let cb = 0, ca = 0
  for (let i = 0; i < observations.length; i++) { cb += huber(eb[i], delta); ca += huber(ea[i], delta) }
  const n = Math.max(1, observations.length)
  const b = Math.sqrt(cb / n), a = Math.sqrt(ca / n)
  return { delta, before: b, after: a, improved: a <= b }
}

// Scale constraints — turn known real-world distances ("scale bars") into the one
// number an up-to-scale SfM model is missing. Pure, no Vue/Pinia/OPFS/DOM.
//
// Scale is one of the seven gauge freedoms of the reprojection cost: a similarity
// applied to the whole reconstruction leaves every residual unchanged. So fitting
// the scale *after* bundle adjustment produces exactly the same model as
// constraining it inside BA would — for a single bar the two are identical, and
// they diverge only with ≥2 mutually disagreeing bars (see METHODS.md §"Scale").
// That is why this file is a four-line weighted least squares and not Rust.
//
// Conventions:
//   • `modelDistance` is a Euclidean distance in the SfM world frame (arbitrary
//     units); `knownDistance` is the surveyed/measured distance in METRES.
//   • The fit is `s = Σ w·d_model·d_known / Σ w·d_model²` — the weighted LSQ
//     minimiser of Σ w·(s·d_model − d_known)². It is scale-only: there is no
//     offset term, because a distance of zero model units is a distance of zero
//     metres by construction.
//   • A residual is `s·d_model − d_known`, in metres, signed (positive ⇒ the
//     model says the bar is longer than the user entered).
//
// The scale NEVER rewrites point/camera coordinates — it is a property of the
// projection *frame* (`frameFromScaledLocal` in projection.js). Rescaling the
// cloud would invalidate the depth-map staleness stamp and contradict every
// recorded summary number.

// Fit a single scale factor from ≥1 distance constraints.
//   constraints: [{ id?, modelDistance, knownDistance, weight?, accuracy? }]
//     weight   — inverse variance (1/σ²); defaults to 1 ("equal weight").
//     accuracy — 1σ in metres, carried through only so the per-constraint
//                normalised residual can be reported. Absent ⇒ null, never 1:
//                a bar with no declared accuracy has no σ to normalise by, and
//                inventing one would present an unweighted fit as a surveyed one.
// Returns { scale, rms, count, constraints: [...] } or null on degenerate input
// (no usable constraint, non-finite values, or zero total model length) —
// matching fitSimilarity's "null rather than a meaningless answer" contract.
export function fitScale(constraints) {
  if (!Array.isArray(constraints) || constraints.length === 0) return null

  let num = 0, den = 0
  for (const c of constraints) {
    const dm = c?.modelDistance, dk = c?.knownDistance
    if (!Number.isFinite(dm) || !Number.isFinite(dk)) return null
    if (!(dm > 0) || !(dk > 0)) return null
    const w = weightOf(c)
    num += w * dm * dk
    den += w * dm * dm
  }
  if (!(den > 0) || !Number.isFinite(num)) return null

  const scale = num / den
  if (!Number.isFinite(scale) || !(scale > 0)) return null

  let weightedSumSq = 0, weightSum = 0
  const rows = constraints.map((c) => {
    const residual = scale * c.modelDistance - c.knownDistance
    const weight = weightOf(c)
    weightedSumSq += weight * residual * residual
    weightSum += weight
    const sigma = Number.isFinite(c.accuracy) && c.accuracy > 0 ? c.accuracy : null
    return {
      id: c.id ?? null,
      modelDistance: c.modelDistance,
      knownDistance: c.knownDistance,
      accuracy: sigma,
      weight,
      residual,
      normalizedResidual: sigma != null ? residual / sigma : null,
    }
  })

  return {
    scale,
    // Match fitSimilarity's convention: RMS is evaluated under the same weights
    // that defined the optimum, rather than quietly switching back to an
    // unweighted diagnostic after a weighted fit.
    rms: Math.sqrt(weightedSumSq / weightSum),
    count: rows.length,
    constraints: rows,
  }
}

// An absent or non-positive weight is equal weight, never a rejection: the
// record-level validation (useScaleBarsStore) is where a bad accuracy is refused,
// and a fit must not fail here over a field the user never filled in.
function weightOf(c) {
  return Number.isFinite(c?.weight) && c.weight > 0 ? c.weight : 1
}

// Inverse-variance weight from a 1σ accuracy in metres. Missing/invalid accuracy
// is deliberately weight 1 ("equal weight"), not a fabricated σ — the caller
// labels it as such in the report.
export function weightFromAccuracy(accuracyM) {
  return Number.isFinite(accuracyM) && accuracyM > 0 ? 1 / (accuracyM * accuracyM) : 1
}

// ── Length units ─────────────────────────────────────────────────────────────
// Metres are canonical internally. The UI accepts mm/cm/m because close-range
// users routinely know a dimension in millimetres and converting by hand is
// exactly the kind of silent factor-of-1000 this table exists to prevent.
export const LENGTH_UNITS = {
  mm: { label: 'mm', toM: 0.001 },
  cm: { label: 'cm', toM: 0.01 },
  m:  { label: 'm',  toM: 1 },
}

export function toMetres(value, unit) {
  const u = LENGTH_UNITS[unit] ?? LENGTH_UNITS.m
  return Number.isFinite(value) ? value * u.toM : null
}

export function fromMetres(metres, unit) {
  const u = LENGTH_UNITS[unit] ?? LENGTH_UNITS.m
  return Number.isFinite(metres) ? metres / u.toM : null
}

// ── Evidence digest ──────────────────────────────────────────────────────────
// A fitted scale is a cached result derived from (a) the sparse model, (b) the
// enabled bar records and (c) the image marks of the markers they reference. The
// model is covered by the cloud's own {id, createdAt} stamp; this digest covers
// the other two, so editing a mark or a distance invalidates the fit instead of
// leaving stale metres on screen.
//
//   bars:    [{ id, a:{kind,id}, b:{kind,id}, knownDistanceM, accuracyM, enabled }]
//   markers: [{ id, observations: [{ imageId, px, py }] }]
// Both are sorted here, so caller ordering can never change the digest.
export function scaleEvidenceDigest(bars = [], markers = []) {
  const barPart = bars
    .filter((b) => b?.enabled !== false)
    .map((b) => [b.id, endpointKey(b.a), endpointKey(b.b), b.knownDistanceM ?? null, b.accuracyM ?? null])
    .sort(compareFirst)
  const markerPart = markers
    .map((m) => [m.id, m.role ?? null, m.enabled !== false, (m.observations ?? [])
      // Observation accuracy participates in triangulation, so changing it must
      // invalidate the cached endpoint just as surely as moving the pixel does.
      .map((o) => [o.imageId ?? null, o.px ?? null, o.py ?? null,
        o.accuracyX ?? null, o.accuracyY ?? null])
      .sort(compareFirst)])
    .sort(compareFirst)
  return fnv1a(JSON.stringify([barPart, markerPart]))
}

const endpointKey = (e) => (e ? `${e.kind}:${e.id}` : 'none')
const compareFirst = (x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)

// FNV-1a, 32-bit, hex. Not cryptographic — this only has to change when the
// evidence changes, and be identical across sessions for identical evidence.
function fnv1a(str) {
  let h = 0x811c9dc5
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

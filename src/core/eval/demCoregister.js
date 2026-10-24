// Nuth & Kääb (2011) co-registration of a DEM to a reference DEM: the horizontal
// shift that best explains the height differences on slopes. Pure.
//
// A DEM displaced sideways by t against its reference differs, on a slope of angle α
// facing ψ, by Δh ≈ |t|·tan α·cos(ψ − θ) (θ the shift's direction), plus any vertical
// bias. So Δh / tan α against the aspect is a cosine whose amplitude and phase are the
// shift: fit a·cos ψ + b·sin ψ + c, move by (b, a), repeat until the step is small.
//
// Why it matters here: Find GCPs takes a control point's position from a reference
// image and its height from a reference DEM. Sentinel-2 and REMA disagree by metres;
// on Rachel Glacier the DEM came out 11 m north of REMA and its NMAD on stable rock
// was 8.7 m, 5.3 m once shifted, as good as hist-sfm's surface (5.4 m after its own
// shift). Steep rock turns a few metres of offset into most of the error.
//
// Shift convention: `shift` = [east, north] is where the DEM sits relative to the
// reference, in DEM units: the DEM's feature at p + shift is the reference's at p.

const NMAD_K = 1.4826
const D2R = Math.PI / 180

function median(v) {
  const s = Float64Array.from(v).sort()
  const n = s.length
  return n ? (n % 2 ? s[n >> 1] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN
}
const nmadOf = (v, m = median(v)) => NMAD_K * median(v.map((x) => Math.abs(x - m)))

/**
 * points: [{ x, y, z }] DEM cells (its own heights) in the DEM's frame.
 * sampleRef(x, y) → reference height or null, in the DEM's frame.
 * cell: the spacing (DEM units) for the reference's slope and aspect (central
 * differences, ±cell).
 * → { shift:[east, north], bias (median Δh after the shift), nmadBefore, nmadAfter,
 *     n (points on 5–45° slopes used), iterations, converged } or null with fewer
 *     than 200 usable points (the fit needs every aspect).
 */
export function coregisterNuthKaab(
  points,
  sampleRef,
  { cell, minSlopeDeg = 5, maxSlopeDeg = 45, maxIterations = 8, tolerance = 0.05 } = {},
) {
  // The reference's slope and aspect at each point, fixed through the iterations
  // (the shifts are small against the terrain's scale).
  const use = []
  for (const p of points) {
    const e = sampleRef(p.x + cell, p.y),
      w = sampleRef(p.x - cell, p.y),
      n = sampleRef(p.x, p.y + cell),
      s = sampleRef(p.x, p.y - cell)
    if (![e, w, n, s].every(Number.isFinite) || !Number.isFinite(p.z)) continue
    const gx = (e - w) / (2 * cell),
      gy = (n - s) / (2 * cell)
    const slope = Math.atan(Math.hypot(gx, gy))
    if (slope < minSlopeDeg * D2R || slope > maxSlopeDeg * D2R) continue
    // Aspect: the downhill direction, clockwise from north.
    use.push({ ...p, tan: Math.tan(slope), cos: -gy / Math.hypot(gx, gy), sin: -gx / Math.hypot(gx, gy) })
  }
  if (use.length < 200) return null
  const dh = (t) => use.map((p) => p.z - (sampleRef(p.x - t[0], p.y - t[1]) ?? NaN))
  let t = [0, 0],
    iterations = 0,
    converged = false
  const before = dh(t).filter(Number.isFinite)
  for (; iterations < maxIterations; iterations++) {
    const d = dh(t)
    const ok = d.map(Number.isFinite)
    const vals = d.filter((_, i) => ok[i])
    const m = median(vals),
      spread = nmadOf(vals, m)
    // Normal equations of y = a·cos ψ + b·sin ψ + c over points within 3 NMAD.
    const A = [
        [0, 0, 0],
        [0, 0, 0],
        [0, 0, 0],
      ],
      v = [0, 0, 0]
    for (let i = 0; i < use.length; i++) {
      if (!ok[i] || Math.abs(d[i] - m) > 3 * spread) continue
      const r = [use[i].cos, use[i].sin, 1],
        y = (d[i] - m) / use[i].tan
      for (let a = 0; a < 3; a++) {
        v[a] += r[a] * y
        for (let b = 0; b < 3; b++) A[a][b] += r[a] * r[b]
      }
    }
    const x = solve3(A, v)
    if (!x) break
    // With the DEM at the reference displaced by T, Δh = ref(p − T) − ref(p − t) ≈
    // −∇ref·δ (δ = T − t), and ∇ref = −tan α·(sin ψ, cos ψ) for the downhill aspect ψ:
    // Δh / tan α = δ_north·cos ψ + δ_east·sin ψ. The fit's (a, b) are (δ_north, δ_east).
    const step = [x[1], x[0]]
    t = [t[0] + step[0], t[1] + step[1]]
    if (Math.hypot(...step) < tolerance * cell) {
      converged = true
      iterations++
      break
    }
  }
  const after = dh(t).filter(Number.isFinite)
  return {
    shift: t,
    bias: median(after),
    nmadBefore: nmadOf(before),
    nmadAfter: nmadOf(after),
    n: use.length,
    iterations,
    converged,
  }
}

function solve3(A, b) {
  const det = (M) =>
    M[0][0] * (M[1][1] * M[2][2] - M[1][2] * M[2][1]) -
    M[0][1] * (M[1][0] * M[2][2] - M[1][2] * M[2][0]) +
    M[0][2] * (M[1][0] * M[2][1] - M[1][1] * M[2][0])
  const D = det(A)
  if (!(Math.abs(D) > 1e-12)) return null
  return [0, 1, 2].map((c) => det(A.map((row, r) => row.map((val, k) => (k === c ? b[r] : val)))) / D)
}

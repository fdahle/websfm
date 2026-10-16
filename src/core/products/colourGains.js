// Per-image colour gains from overlapping observations, and the sRGB ↔ linear-light
// tables they work in. Pure. Shared by the mosaicked orthophoto (ortho.js) and the
// mesh texture (texture/), which both pick one photo per surface patch and must make
// neighbouring photos agree in exposure and white balance.

// sRGB ↔ linear light. Blending and gains act on light, not on gamma-encoded bytes.
// The decode interpolates a 257-entry table (bilinear photo samples are fractional);
// the encode is a 2¹⁶-step table, exact to the byte for every 8-bit value.
const SRGB_LIN = new Float64Array(257)
for (let v = 0; v <= 256; v++) {
  const c = Math.min(v, 255) / 255
  SRGB_LIN[v] = c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
}
const LIN_STEPS = 65536
const LIN_SRGB = new Uint8Array(LIN_STEPS + 1)
for (let i = 0; i <= LIN_STEPS; i++) {
  const l = i / LIN_STEPS
  LIN_SRGB[i] = Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * l ** (1 / 2.4) - 0.055))
}
export function srgbToLinear(v) {
  if (!(v > 0)) return 0
  if (v >= 255) return 1
  const f = Math.floor(v)
  return SRGB_LIN[f] + (SRGB_LIN[f + 1] - SRGB_LIN[f]) * (v - f)
}
export function linearToSrgb(l) {
  return LIN_SRGB[l > 0 ? (l < 1 ? Math.round(l * LIN_STEPS) : LIN_STEPS) : 0]
}

const GAIN_SIGMA_S = 0.1         // spread of one sample's log colour ratio between two images
const GAIN_PRIOR = 0.01          // an image's pull to gain 1, as a fraction of its own overlap weight
const GAIN_CLIP_LO = 4, GAIN_CLIP_HI = 250 // sRGB: a sample at either end is clipped, its ratio meaningless
const GAIN_MIN = 0.5, GAIN_MAX = 2

// An sRGB sample with any channel clipped says nothing about gain: a wall at 255 in one
// photo understates its ratio to the other. Callers leave such samples out.
export const gainSampleClipped = (r, g, b) =>
  Math.min(r, g, b) <= GAIN_CLIP_LO || Math.max(r, g, b) >= GAIN_CLIP_HI

// A growable typed array (append-only).
export function growable(Type, n = 1024) {
  let a = new Type(n), len = 0
  return {
    push(v) { if (len === a.length) { const b = new Type(a.length * 2); b.set(a); a = b } a[len++] = v },
    get array() { return a.subarray(0, len) },
    get length() { return len },
  }
}

// Per-image, per-channel gains by least squares over the overlaps. The observations are
// (sample point, image, linear RGB): every image that sees a sample point contributes
// its colour there. For each image pair (i, j) seen together at N sample points with
// mean colours Ī_ij (i's) and Ī_ji (j's), the gains should satisfy g_i Ī_ij = g_j Ī_ji.
// Solved in the LOG domain, x = log g, per channel:
//   Σ_pairs (N_ij / σs²) (x_i − x_j − log(Ī_ji / Ī_ij))²  +  Σ_i x_i² / σg²
// Brown & Lowe's (2007) linear form, Σ N (g_i Ī_ij − g_j Ī_ji)² + an N-weighted prior on
// (1 − g), is minimised by shrinking every gain towards 0 wherever the overlap ratios
// are inconsistent around loops; on quarry-80 it put the median gain at 0.62 with 63
// channels clamped. In the log domain the data term ignores a common factor, so the
// prior cannot shrink the gains: it keeps the overall level (the overlap-weighted mean
// log gain is exactly 0) and bounds drift. The normal equations are a graph Laplacian
// plus a diagonal, sparse: Jacobi-preconditioned CG. An image overlapping nothing keeps
// gain 1. Each image's prior is GAIN_PRIOR of its own overlap weight, so small
// systematic per-pair biases (vignetting, view-angle reflectance) cannot add up along a
// block — the prior couples over ~1/√GAIN_PRIOR images, while two neighbours are still
// matched to ~½ % (quarry-80, with clipped samples left out by gainSampleClipped).
//   nImages, nPoints — sizes; obsPt / obsImg — Int32 per observation; obsRgb — 3 per observation
// → { gains: Float64Array(3·nImages), summary }
export function fitGains({ nImages: n, nPoints: L, obsPt: opt, obsImg: oimg, obsRgb: orgb }) {
  // Group the observations by sample point (a stable counting sort keeps images ascending).
  const O = opt.length
  const start = new Int32Array(L + 1)
  for (let o = 0; o < O; o++) start[opt[o] + 1]++
  for (let p = 0; p < L; p++) start[p + 1] += start[p]
  const order = new Int32Array(O), fill = start.slice(0, L)
  for (let o = 0; o < O; o++) order[fill[opt[o]]++] = o
  // Overlap sums per image pair (a < b).
  const pairOf = new Map(), pa = [], pb = [], pn = [], sa = [], sb = []
  for (let p = 0; p < L; p++) {
    const s0 = start[p], s1 = start[p + 1]
    if (s1 - s0 < 2) continue
    for (let x = s0; x < s1; x++) {
      const o = order[x]
      for (let y = x + 1; y < s1; y++) {
        const q = order[y], a = oimg[o], b = oimg[q], key = a * n + b
        let e = pairOf.get(key)
        if (e === undefined) { e = pa.length; pairOf.set(key, e); pa.push(a); pb.push(b); pn.push(0); sa.push(0, 0, 0); sb.push(0, 0, 0) }
        pn[e]++
        for (let c = 0; c < 3; c++) { sa[3 * e + c] += orgb[3 * o + c]; sb[3 * e + c] += orgb[3 * q + c] }
      }
    }
  }
  const gains = new Float64Array(3 * n).fill(1)
  const overlapping = new Uint8Array(n)
  for (let e = 0; e < pa.length; e++) { overlapping[pa[e]] = 1; overlapping[pb[e]] = 1 }
  const iS = 1 / (GAIN_SIGMA_S * GAIN_SIGMA_S)
  let clamped = 0
  for (let c = 0; c < 3 && pa.length; c++) {
    const diag = new Float64Array(n), rhs = new Float64Array(n), off = new Float64Array(pa.length)
    for (let e = 0; e < pa.length; e++) {
      const Iab = sa[3 * e + c], Iba = sb[3 * e + c]
      if (!(Iab > 1e-4 * pn[e] && Iba > 1e-4 * pn[e])) continue // a black overlap says nothing about gain
      const w = pn[e] * iS, d = Math.log(Iba / Iab)
      diag[pa[e]] += w; diag[pb[e]] += w; off[e] = -w
      rhs[pa[e]] += w * d; rhs[pb[e]] -= w * d
    }
    // The prior: a fraction of each image's own overlap weight, plus 1 so an image with
    // no usable overlap stays at log gain 0.
    for (let i = 0; i < n; i++) diag[i] = diag[i] * (1 + GAIN_PRIOR) + 1
    const x = solveGains(diag, off, pa, pb, rhs)
    for (let i = 0; i < n; i++) {
      const gi = Math.exp(x[i]), v = Math.min(GAIN_MAX, Math.max(GAIN_MIN, gi))
      if (v !== gi && overlapping[i]) clamped++
      gains[3 * i + c] = v
    }
  }
  const balanced = []
  for (let i = 0; i < n; i++) if (overlapping[i]) balanced.push((gains[3 * i] + gains[3 * i + 1] + gains[3 * i + 2]) / 3)
  balanced.sort((a, b) => a - b)
  return {
    gains,
    summary: {
      observations: O, pairs: pa.length, images: balanced.length, clamped,
      min: balanced.length ? balanced[0] : null,
      median: balanced.length ? balanced[balanced.length >> 1] : null,
      max: balanced.length ? balanced[balanced.length - 1] : null,
    },
  }
}

// Jacobi-preconditioned CG on the gains' normal equations: A = diag + the symmetric
// off-diagonal entries off[e] at (pa[e], pb[e]). Starts from 0 (every log gain at the prior).
function solveGains(diag, off, pa, pb, rhs) {
  const n = diag.length
  const mul = (x, out) => {
    for (let i = 0; i < n; i++) out[i] = diag[i] * x[i]
    for (let e = 0; e < off.length; e++) { out[pa[e]] += off[e] * x[pb[e]]; out[pb[e]] += off[e] * x[pa[e]] }
  }
  const x = new Float64Array(n), r = new Float64Array(n), z = new Float64Array(n), p = new Float64Array(n), q = new Float64Array(n)
  mul(x, q)
  let bn = 0
  for (let i = 0; i < n; i++) { r[i] = rhs[i] - q[i]; z[i] = r[i] / diag[i]; p[i] = z[i]; bn += rhs[i] * rhs[i] }
  let rz = 0
  for (let i = 0; i < n; i++) rz += r[i] * z[i]
  for (let it = 0; it < 10 * n + 100; it++) {
    let rr = 0
    for (let i = 0; i < n; i++) rr += r[i] * r[i]
    if (rr <= 1e-24 * bn) break
    mul(p, q)
    let pq = 0
    for (let i = 0; i < n; i++) pq += p[i] * q[i]
    if (!(pq > 0)) break
    const alpha = rz / pq
    for (let i = 0; i < n; i++) { x[i] += alpha * p[i]; r[i] -= alpha * q[i]; z[i] = r[i] / diag[i] }
    let rzNew = 0
    for (let i = 0; i < n; i++) rzNew += r[i] * z[i]
    const beta = rzNew / rz
    rz = rzNew
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i]
  }
  return x
}

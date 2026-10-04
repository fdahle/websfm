// Shared low-level primitives for template-free fiducial search.
//
// Three primitives: generate an analytic prototype, measure the film rectangle,
// find the best ZNCC peak near a guess. `fiducialDetection.js` (anonymous slots →
// detections) is the policy over them. They once lived as copy-pasted forks in two
// policy modules and drifted into two live bugs (a `Math.max(...typedArray)` stack
// overflow on any real-sized scan, and a peak margin measured against a
// near-duplicate of the peak itself) — keep shared math here, never in a policy.
//
// Pure and worker-safe. Grayscale images are `{ data: Float32Array, width,
// height }`, row-major, values 0..255; patches are square `{ data, size }`.

import { matchZNCC, subpixelPeak } from './fiducialDetect.js'

export const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v))

/**
 * How many analytic variants a prototype family has. `generic` sweeps
 * dot/crosshair/ring; `right-angle` sweeps the four corner orientations;
 * everything else is a single shape.
 */
export function variantsFor(family) {
  if (family === 'right-angle') return 4
  if (family === 'generic') return 3
  return 1
}

/**
 * Generated prototypes deliberately describe families, not a particular scan.
 * Values are zero/one; ZNCC removes their mean and the target's exposure.
 *
 * `strokeFrac` sets the stroke/ring width as a fraction of the patch size. The
 * two callers pass different values (bootstrap 0.12, anonymous detection 0.10);
 * that divergence predates this module and is preserved rather than silently
 * unified, since it shifts which peaks each policy accepts.
 */
export function makeFiducialPrototype(family, size, variant = 0, { strokeFrac = 0.12 } = {}) {
  const S = size % 2 ? size : size + 1
  const h = (S - 1) / 2
  const data = new Float32Array(S * S).fill(1)
  const dark = (x, y) => { if (x >= 0 && y >= 0 && x < S && y < S) data[y * S + x] = 0 }
  const r = Math.max(1, Math.round(S * strokeFrac))
  for (let y = 0; y < S; y++) for (let x = 0; x < S; x++) {
    const dx = x - h, dy = y - h
    if (family === 'generic') {
      // Pick the variant FIRST, then test its own geometry. Folding the two into one
      // condition (`variant === 0 && insideDot`) made every pixel *outside* a variant's
      // shape fall through to the ring branch, so the dot and crosshair templates were
      // each drawn inside a filled ring — three variations of a blob rather than the
      // three distinct shapes this family exists to sweep.
      const v = variant % 3
      if (v === 0) { // dot
        if (dx * dx + dy * dy <= (S * 0.18) ** 2) dark(x, y)
      } else if (v === 1) { // crosshair
        if (Math.abs(dx) <= r || Math.abs(dy) <= r) dark(x, y)
      } else { // ring + centre
        const d = Math.hypot(dx, dy), rr = S * 0.29
        if (Math.abs(d - rr) <= r || d <= r) dark(x, y)
      }
    } else if (family === 'right-angle') {
      const q = variant % 4
      const sx = q === 0 || q === 3 ? 1 : -1
      const sy = q < 2 ? 1 : -1
      if ((Math.abs(dy) <= r && dx * sx >= 0) || (Math.abs(dx) <= r && dy * sy >= 0)) dark(x, y)
    } else if (family === 'cut-45') {
      if (Math.abs(dx + dy) <= r || (dx * dx + (dy + S * 0.25) ** 2 <= (S * 0.12) ** 2)) dark(x, y)
    }
  }
  return { data, size: S }
}

/** Contrast-inverted copy of a patch (a light mark on dark film, or vice versa). */
export function invertPatch(p) {
  const data = new Float32Array(p.data.length)
  for (let i = 0; i < data.length; i++) data[i] = 1 - p.data[i]
  return { data, size: p.size }
}

/**
 * Locate the film rectangle inside a scan by the strongest intensity step in the
 * outer `maxFrac` of each row/column profile. `confidence` is the weakest of the
 * four edge strengths over the image's dynamic range, so a flat (edgeless) image
 * reports ~0 and the caller can refuse to invent a frame.
 *
 * NOTE: the range scan is an explicit loop. `Math.max(...gray.data)` reads as the
 * obvious spelling but throws `RangeError: Maximum call stack size exceeded` for
 * any array past ~124k elements — i.e. every real scan, which is downscaled to
 * 1536 px on the long edge (~2.4M samples).
 *
 * @returns {{ left:number, right:number, top:number, bottom:number, confidence:number }}
 */
export function estimateFrameBounds(gray, maxFrac = 0.2) {
  const profile = (vertical) => {
    const n = vertical ? gray.width : gray.height
    const cross = vertical ? gray.height : gray.width
    const out = new Float64Array(n)
    for (let i = 0; i < n; i++) {
      let sum = 0
      for (let j = 0; j < cross; j++) sum += vertical ? gray.data[j * gray.width + i] : gray.data[i * gray.width + j]
      out[i] = sum / cross
    }
    return out
  }
  const edge = (p, fromStart) => {
    const limit = Math.max(2, Math.floor(p.length * maxFrac))
    let bestI = fromStart ? 1 : p.length - 2, best = 0
    for (let q = 1; q < limit; q++) {
      const i = fromStart ? q : p.length - 1 - q
      const d = Math.abs(p[i] - p[i + (fromStart ? -1 : 1)])
      if (d > best) { best = d; bestI = i }
    }
    return { at: bestI, strength: best }
  }
  const xp = profile(true), yp = profile(false)
  const l = edge(xp, true), r = edge(xp, false), t = edge(yp, true), b = edge(yp, false)
  let lo = Infinity, hi = -Infinity
  for (const v of gray.data) { if (v < lo) lo = v; if (v > hi) hi = v }
  const range = hi - lo || 1
  return {
    left: l.at, right: r.at, top: t.at, bottom: b.at,
    confidence: Math.min(l.strength, r.strength, t.strength, b.strength) / range,
  }
}

/**
 * Best ZNCC hit for any prototype of `family` within `radius` of `(cx, cy)`,
 * sweeping `cfg.prototypeSizes` × the family's variants × polarity.
 *
 * `margin` is the gap to the best *spatially distinct* runner-up. The distance
 * guard is load-bearing: adjacent sizes/variants all peak on the same mark and
 * score almost identically, so measuring the margin against them reports ~0 for
 * a perfectly unambiguous mark and the caller rejects it as ambiguous.
 *
 * `cfg.polarity`: `'dark'` | `'light'` | anything else ⇒ try both.
 * `cfg.variants`: optional subset of the family's variant indices.
 *
 * @returns {null | { x:number, y:number, score:number, size:number,
 *                    variant:number, polarity:'dark'|'light', tpl:object, margin:number }}
 */
export function bestPrototypeHit(gray, cx, cy, radius, family, cfg = {}) {
  const sizes = cfg.prototypeSizes ?? [9, 13, 17, 25]
  const protoOpts = { strokeFrac: cfg.strokeFrac }
  let best = null
  const hits = []
  for (const size of sizes) {
    const half = (size - 1) >> 1
    // A prototype wider than the image leaves no legal centre. Skip it: clamping
    // to an inverted [lo, hi] would yield an out-of-bounds search box that reads
    // undefined pixels and scores a meaningless 0.
    const xLo = half, xHi = gray.width - 1 - half
    const yLo = half, yHi = gray.height - 1 - half
    if (xHi < xLo || yHi < yLo) continue
    const x0 = clamp(Math.round(cx - radius), xLo, xHi)
    const y0 = clamp(Math.round(cy - radius), yLo, yHi)
    const x1 = clamp(Math.round(cx + radius), xLo, xHi)
    const y1 = clamp(Math.round(cy + radius), yLo, yHi)
    if (x1 < x0 || y1 < y0) continue
    // cfg.variants restricts the sweep to known orientations (the native refine
    // reuses the coarse winner's — re-sweeping all of them costs ~6× for nothing).
    const variants = cfg.variants?.length ? cfg.variants
      : Array.from({ length: variantsFor(family) }, (_, v) => v)
    for (const v of variants) {
      const base = makeFiducialPrototype(family, size, v, protoOpts)
      const templates = cfg.polarity === 'dark' ? [[base, 'dark']]
        : cfg.polarity === 'light' ? [[invertPatch(base), 'light']]
          : [[base, 'dark'], [invertPatch(base), 'light']]
      for (const [tpl, polarity] of templates) {
        const hit = matchZNCC(gray, tpl, x0, y0, x1, y1)
        const rec = { ...hit, tpl, size, variant: v, polarity }
        hits.push(rec)
        if (!best || hit.score > best.score) best = rec
      }
    }
  }
  if (!best) return null
  // Runner-up must be spatially distinct; adjacent samples describe one peak.
  let second = -1 // ZNCC floor, so a lone peak gets a large but finite margin
  for (const h of hits) {
    if (Math.hypot(h.x - best.x, h.y - best.y) <= Math.max(2, best.size / 3)) continue
    if (h.score > second) second = h.score
  }
  const sub = subpixelPeak(gray, best.tpl, best.x, best.y)
  return { ...best, x: sub.x, y: sub.y, margin: best.score - second }
}

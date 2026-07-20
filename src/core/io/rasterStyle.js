// How an imported multi-band reference raster is turned into displayable RGBA.
//
// The problem this exists for: geotiff's `readRGB()` scales samples by the
// DECLARED bit depth, so a 6-band uint16 Sentinel-2 scene — whose reflectance
// values live around 0…3000 — divides by 65535 and renders as ~pixel value 12,
// i.e. black. Anything deeper than 8-bit needs a contrast stretch, and anything
// with more than 3 bands also needs to be told which bands to show, because the
// band ORDER of a stack is not recoverable from the file.
//
// Pure: plain arrays in, plain arrays out. The band *reading* (geotiff) happens
// in workers/ops/io.js; everything numeric is here so it can be tested.
import { rampByName } from '../products/colormap.js'

export const STYLE_MODES = ['gray', 'rgb', 'index']
export const STRETCH_MODES = ['percentile', 'minmax', 'manual']

// Normalised-difference index presets. Bands are named by ROLE (NIR, Red, …)
// rather than index, precisely because the index is what the user has to supply
// — nothing in the file says which plane is NIR.
export const INDEX_PRESETS = {
  ndvi: { label: 'NDVI — vegetation', roleA: 'NIR', roleB: 'Red' },
  ndwi: { label: 'NDWI — water', roleA: 'Green', roleB: 'NIR' },
  ndsi: { label: 'NDSI — snow / ice', roleA: 'Green', roleB: 'SWIR' },
  custom: { label: 'Custom — (A−B) / (A+B)', roleA: 'A', roleB: 'B' },
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// Does this raster need styling at all, or can the legacy `readRGB()` fast path
// handle it? An 8-bit 1–3 band image is already display-ready and must keep
// going down the old path unchanged — that is the no-regression guarantee for
// every ortho imported before band math existed.
export function needsStyling({ bands = 1, bitsPerSample = 8, sampleFormat = 1 } = {}) {
  return bands > 3 || bitsPerSample > 8 || sampleFormat === 3
}

// The style a raster gets when the user hasn't chosen one. Deliberately NOT
// clever about band roles: with ≥3 bands it shows the first three as R,G,B,
// which is as good a guess as any and is visibly wrong in a way that invites
// correction — as opposed to a plausible-looking false-colour composite the
// user would trust.
export function defaultRasterStyle({ bands = 1, bitsPerSample = 8, sampleFormat = 1 } = {}) {
  const deep = bitsPerSample > 8 || sampleFormat === 3
  const base = {
    stretch: deep ? 'percentile' : 'minmax',
    loPct: 2,
    hiPct: 98,
    // Manual limits, per channel. Null until the user switches to 'manual',
    // which prefills them from whatever the current stretch resolved to.
    manual: null,
    gamma: 1,
    ramp: 'rdylgn',
  }
  if (bands >= 3) return { ...base, mode: 'rgb', bandR: 0, bandG: 1, bandB: 2 }
  return { ...base, mode: 'gray', band: 0 }
}

// Normalise a persisted style against the raster it belongs to: fills defaults
// for fields added later and clamps band indices that no longer exist (a style
// copied between rasters, or an old project). Never throws — a broken style
// must degrade to a visible image, not to an import failure.
export function resolveRasterStyle(style, meta = {}) {
  const def = defaultRasterStyle(meta)
  const s = { ...def, ...(style || {}) }
  const nb = Math.max(1, meta.bands || 1)
  const fix = (i) => clamp(Math.round(Number(i) || 0), 0, nb - 1)
  if (!STYLE_MODES.includes(s.mode)) s.mode = def.mode
  if (!STRETCH_MODES.includes(s.stretch)) s.stretch = def.stretch
  // An RGB style on a single-band raster is not renderable — fall back rather
  // than emit three copies of band 0 and call it colour.
  if (s.mode === 'rgb' && nb < 3) s.mode = 'gray'
  if (s.mode === 'index' && nb < 2) s.mode = 'gray'
  s.band = fix(s.band); s.bandR = fix(s.bandR); s.bandG = fix(s.bandG); s.bandB = fix(s.bandB)
  s.bandA = fix(s.bandA ?? 0); s.bandB2 = fix(s.bandB2 ?? Math.min(1, nb - 1))
  s.gamma = Number.isFinite(s.gamma) && s.gamma > 0 ? s.gamma : 1
  s.loPct = Number.isFinite(s.loPct) ? clamp(s.loPct, 0, 100) : def.loPct
  s.hiPct = Number.isFinite(s.hiPct) ? clamp(s.hiPct, 0, 100) : def.hiPct
  if (s.hiPct <= s.loPct) { s.loPct = def.loPct; s.hiPct = def.hiPct }
  if (!INDEX_PRESETS[s.index]) s.index = 'ndvi'
  return s
}

// The band indices a style actually reads, in the order composeStyledRgba
// expects them. Lets the caller decode ONLY those planes — reading all six
// bands of a 5000×5000 uint16 scene to show three of them is 300 MB of waste.
export function bandsUsedBy(style) {
  const s = style || {}
  if (s.mode === 'rgb') return [s.bandR ?? 0, s.bandG ?? 1, s.bandB ?? 2]
  if (s.mode === 'index') return [s.bandA ?? 0, s.bandB2 ?? 1]
  return [s.band ?? 0]
}

// Nearest-rank percentile over a value list. Copies before sorting — the caller's
// decimated sample is reused for the classifier and must not be reordered.
export function percentileRange(values, loPct = 2, hiPct = 98) {
  const v = Array.from(values || []).filter(Number.isFinite).sort((a, b) => a - b)
  if (!v.length) return null
  const at = (p) => v[clamp(Math.round((p / 100) * (v.length - 1)), 0, v.length - 1)]
  const lo = at(loPct), hi = at(hiPct)
  return hi > lo ? [lo, hi] : minMaxRange(v)
}

export function minMaxRange(values) {
  let lo = Infinity, hi = -Infinity
  for (const v of values || []) {
    if (!Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return null
  // A constant band would divide by zero downstream; widen it so it renders flat
  // mid-grey instead of producing NaNs.
  return hi > lo ? [lo, hi] : [lo, lo + 1]
}

// Resolve the display range for ONE channel from its sample values.
// `manualRange` (when the style is manual) wins outright.
export function resolveRange(values, style, manualRange = null) {
  if (style?.stretch === 'manual' && manualRange
      && Number.isFinite(manualRange[0]) && Number.isFinite(manualRange[1])
      && manualRange[1] > manualRange[0]) {
    return [manualRange[0], manualRange[1]]
  }
  if (style?.stretch === 'minmax') return minMaxRange(values)
  return percentileRange(values, style?.loPct ?? 2, style?.hiPct ?? 98)
}

// Value → 0..255 through the channel range and gamma. Gamma > 1 brightens
// (out = t^(1/gamma)), matching the usual image-viewer convention.
export function stretchTo255(v, range, gamma = 1) {
  if (!range) return 0
  const [lo, hi] = range
  const t = clamp((v - lo) / (hi - lo), 0, 1)
  return Math.round(255 * (gamma === 1 ? t : Math.pow(t, 1 / gamma)))
}

export function normalizedDifference(a, b) {
  const d = a + b
  return d === 0 ? NaN : (a - b) / d
}

// Compose the final RGBA plane.
//
// `channels` are the raw band planes in bandsUsedBy() order; `ranges` the
// per-channel display range (index mode ignores them — the index is its own
// fixed [-1,1] scale, because stretching NDVI would move the zero crossing that
// gives it meaning). A nodata sample anywhere in a pixel's inputs makes the
// whole pixel transparent, so a stack's collar never renders as spurious colour.
export function composeStyledRgba({ width, height, style, channels, ranges = [], nodata = null }) {
  const n = width * height
  const out = new Uint8Array(n * 4)
  const s = style || {}
  const gamma = s.gamma ?? 1
  const isNodata = (v) => !Number.isFinite(v) || (nodata != null && v === nodata)

  if (s.mode === 'index') {
    const [A, B] = channels
    const ramp = rampByName(s.ramp)
    for (let i = 0; i < n; i++) {
      const a = A[i], b = B[i]
      if (isNodata(a) || isNodata(b)) continue
      const nd = normalizedDifference(a, b)
      if (!Number.isFinite(nd)) continue
      // [-1,1] → [0,1] for the ramp; gamma still applies as a display curve.
      const t = gamma === 1 ? (nd + 1) / 2 : Math.pow(clamp((nd + 1) / 2, 0, 1), 1 / gamma)
      const [r, g, bl] = ramp(t)
      out[i * 4] = r; out[i * 4 + 1] = g; out[i * 4 + 2] = bl; out[i * 4 + 3] = 255
    }
    return out
  }

  if (s.mode === 'rgb') {
    const [R, G, B] = channels
    for (let i = 0; i < n; i++) {
      const r = R[i], g = G[i], b = B[i]
      if (isNodata(r) || isNodata(g) || isNodata(b)) continue
      out[i * 4] = stretchTo255(r, ranges[0], gamma)
      out[i * 4 + 1] = stretchTo255(g, ranges[1], gamma)
      out[i * 4 + 2] = stretchTo255(b, ranges[2], gamma)
      out[i * 4 + 3] = 255
    }
    return out
  }

  const [V] = channels
  for (let i = 0; i < n; i++) {
    const v = V[i]
    if (isNodata(v)) continue
    const g = stretchTo255(v, ranges[0], gamma)
    out[i * 4] = g; out[i * 4 + 1] = g; out[i * 4 + 2] = g; out[i * 4 + 3] = 255
  }
  return out
}

// A stable identity for a style, so a cached full-resolution plane can be told
// apart from the style currently on screen. Restyling repaints the preview
// immediately but leaves the (expensive) plane stale on purpose, and this is what
// `ensureRasterLoaded` compares to know it must re-decode instead of reading the
// sidecar. Only the fields that change PIXELS are included — `ranges` is excluded
// because it is an echoed-back output of the last decode, not an input.
export function styleStamp(style) {
  if (!style) return 'none'
  const s = style
  const parts = [
    s.mode, s.stretch, s.gamma, s.ramp,
    s.mode === 'rgb' ? [s.bandR, s.bandG, s.bandB]
      : s.mode === 'index' ? [s.index, s.bandA, s.bandB2]
        : [s.band],
    s.stretch === 'manual' ? JSON.stringify(s.manual ?? null) : [s.loPct, s.hiPct],
  ]
  return parts.flat().join('|')
}

// One-line human summary of a style, for the log + the sidebar row.
export function describeStyle(style) {
  const s = style || {}
  const stretch = s.stretch === 'manual'
    ? 'manual'
    : s.stretch === 'minmax' ? 'min–max' : `${s.loPct ?? 2}–${s.hiPct ?? 98}%`
  if (s.mode === 'index') {
    return `${(INDEX_PRESETS[s.index]?.label || s.index || 'index').split(' —')[0]}`
      + ` (bands ${(s.bandA ?? 0) + 1}, ${(s.bandB2 ?? 1) + 1}), ${s.ramp || 'rdylgn'}`
  }
  if (s.mode === 'rgb') {
    return `RGB ← bands ${(s.bandR ?? 0) + 1}, ${(s.bandG ?? 1) + 1}, ${(s.bandB ?? 2) + 1}, ${stretch}`
  }
  return `grey ← band ${(s.band ?? 0) + 1}, ${stretch}`
}

// 16-bit image samples → 8-bit RGBA by a linear percentile stretch (pure).
//
// Why not the high byte: a 16-bit sensor rarely fills its range. A MicaSense
// Altum-PT pan frame spans DN ~6,300–37,000 (p1–p99), which `>> 8` maps to grey
// levels 24–145: half the 8-bit contrast, quantised to ~120 levels. SIFT's contrast
// threshold is absolute on [0, 1] intensities, so a compressed range silently drops
// keypoints (1,100–6,900 per image at 2400 px on the Monster beach set). Stretching
// the [lo, hi] percentile range to 0–255 restores the contrast and uses all 256 levels.
//
// The mapping is per image and shared by all colour channels (so an RGB image keeps
// its colour balance). Alpha, when present, is scaled by its full range, not stretched.

/**
 * Low/high percentiles of the colour samples, from a 65,536-bin histogram.
 * @param {Uint16Array} samples  interleaved, `spp` samples per pixel
 * @param {number} spp           1 gray, 2 gray+alpha, 3 RGB, 4 RGBA
 * @returns {{ lo: number, hi: number }}
 */
export function percentileRange(samples, spp, { loQ = 0.005, hiQ = 0.995 } = {}) {
  const colour = spp === 2 || spp === 4 ? spp - 1 : spp
  const hist = new Uint32Array(65536)
  let n = 0
  for (let i = 0; i < samples.length; i += spp) {
    for (let c = 0; c < colour; c++) hist[samples[i + c]]++
    n += colour
  }
  if (!n) return { lo: 0, hi: 65535 }
  const loTarget = Math.floor(loQ * (n - 1)), hiTarget = Math.floor(hiQ * (n - 1))
  let lo = 0, hi = 65535, acc = 0, haveLo = false
  for (let v = 0; v < 65536; v++) {
    acc += hist[v]
    if (!haveLo && acc > loTarget) { lo = v; haveLo = true }
    if (acc > hiTarget) { hi = v; break }
  }
  // A flat image (lo === hi) would divide by zero; widen to one DN either side.
  if (hi <= lo) { lo = Math.max(0, lo - 1); hi = Math.min(65535, lo + 2) }
  return { lo, hi }
}

/**
 * Map 16-bit samples to interleaved 8-bit RGBA.
 * @param {Uint16Array} samples  interleaved, `spp` samples per pixel
 * @param {number} spp           1, 2, 3 or 4
 * @param {{ lo: number, hi: number }} range
 * @param {{ invert?: boolean }} [opts]  invert = photometric MinIsWhite
 */
export function stretch16ToRgba(samples, width, height, spp, { lo, hi }, { invert = false } = {}) {
  if (![1, 2, 3, 4].includes(spp)) throw new Error(`stretch16ToRgba: unsupported samples per pixel ${spp}`)
  const npx = width * height
  if (samples.length < npx * spp) throw new Error('stretch16ToRgba: sample buffer too short')
  // One lookup table: 65,536 entries, then a plain indexed copy per sample.
  const lut = new Uint8Array(65536)
  const k = 255 / (hi - lo)
  for (let v = 0; v < 65536; v++) {
    const m = v <= lo ? 0 : v >= hi ? 255 : Math.round((v - lo) * k)
    lut[v] = invert ? 255 - m : m
  }
  const out = new Uint8ClampedArray(npx * 4)
  for (let p = 0, s = 0; p < npx; p++, s += spp) {
    const o = p * 4
    if (spp <= 2) {
      const g = lut[samples[s]]
      out[o] = g; out[o + 1] = g; out[o + 2] = g
      out[o + 3] = spp === 2 ? samples[s + 1] >> 8 : 255
    } else {
      out[o] = lut[samples[s]]; out[o + 1] = lut[samples[s + 1]]; out[o + 2] = lut[samples[s + 2]]
      out[o + 3] = spp === 4 ? samples[s + 3] >> 8 : 255
    }
  }
  return out
}

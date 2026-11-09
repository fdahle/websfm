// Radiometry of MicaSense band images (plan-after-0.7 ▸ MSP-3): raw DN → radiance →
// reflectance, and the thermal band → °C. A port of MicaSense's MIT-licensed
// `imageprocessing` model (micasense/image.py radiance, vignette; panel.py; metadata.py),
// reading the plain values core/io/metadata.js bandMetadata keeps. Its license:
// licenses/code/MicaSense.txt.
//
//   radiance L = V(x, y) · R(y) · (DN − black) / (gain · exposure) · a1 / 2^bits
//   R(y)     = 1 / (1 + a2·y/exposure − a3·y)        (row-dependent readout correction)
//   V(x, y)  = 1 / vignetting polynomial            (radial, or 2-D on newer cameras)
//   reflectance = π · L / E, E the irradiance on the ground in that band
//   thermal (LWIR): DN is centikelvin, °C = DN/100 − 273.15
//
// Units: L in W/m²/sr/nm, E in W/m²/nm, reflectance 0–1.

// Legacy RedEdge firmware wrote 1/6329 s for a real 0.274 ms (metadata.py exposure).
export function exposureSeconds(band, model = '') {
  const e = band.exposure
  if (e != null && model !== 'Altum' && Math.abs(e - 1 / 6329) < 1e-6) return 0.000274
  return e
}

// The vignetting correction at pixel (x, y) of a w × h image: the factor a DN is
// multiplied by. 1 when the band carries no model.
export function vignetteFn(band, w, h) {
  const v = band.vignette
  if (v?.center && v.poly) {
    const [cx, cy] = v.center
    const k = v.poly
    return (x, y) => {
      const r = Math.hypot(x - cx, y - cy)
      // 1 + k0·r + k1·r² + …, by Horner.
      let p = 0
      for (let i = k.length - 1; i >= 0; i--) p = (p + k[i]) * r
      return 1 / (1 + p)
    }
  }
  if (v?.poly2D) {
    const c = v.poly2D,
      e = v.exponents2D
    return (x, y) => {
      const xv = x / w,
        yv = y / h
      let p = 0
      for (let i = 0; i < c.length; i++) p += c[i] * xv ** e[2 * i] * yv ** e[2 * i + 1]
      return 1 / p
    }
  }
  return () => 1
}

// Whether `band` can be calibrated: a radiometric model, or the thermal band.
export function hasRadiometry(band) {
  if (!band) return false
  if (band.thermal) return true
  const cal = band.radiometricCal
  return cal?.length === 3 && cal[0] > 0 && band.exposure > 0 && band.gain > 0 && band.bits > 0
}

// Radiance (or °C for the thermal band) of every pixel of a raw band image: `dn` the
// image's native DN (12- or 16-bit, as stored), w × h, row-major. Returns Float32Array.
// `model`: the camera model, for the exposure quirk of old RedEdge firmware.
export function radianceImage(dn, w, h, band, model = '') {
  const out = new Float32Array(w * h)
  if (band.thermal) {
    for (let i = 0; i < out.length; i++) out[i] = dn[i] / 100 - 273.15
    return out
  }
  const [a1, a2, a3] = band.radiometricCal
  const exposure = exposureSeconds(band, model)
  const black = band.blackLevel ?? 0
  const scale = a1 / (band.gain * exposure * 2 ** band.bits)
  const vig = vignetteFn(band, w, h)
  for (let y = 0; y < h; y++) {
    const r = 1 / (1 + (a2 * y) / exposure - a3 * y)
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const d = dn[i] - black
      out[i] = d > 0 ? vig(x, y) * r * d * scale : 0
    }
  }
  return out
}

// The mean of `img` (w wide) inside a convex quadrilateral `corners` ([[x, y] × 4], in
// order around it), over pixel centres. Returns { mean, std, count }.
export function regionStats(img, w, corners) {
  const xs = corners.map((c) => c[0]),
    ys = corners.map((c) => c[1])
  const x0 = Math.max(0, Math.floor(Math.min(...xs))),
    x1 = Math.ceil(Math.max(...xs))
  const y0 = Math.max(0, Math.floor(Math.min(...ys))),
    y1 = Math.ceil(Math.max(...ys))
  const h = img.length / w
  // Inside when on the same side of every edge as the polygon's winding.
  const n = corners.length
  let area2 = 0
  for (let i = 0; i < n; i++) {
    const [ax, ay] = corners[i],
      [bx, by] = corners[(i + 1) % n]
    area2 += ax * by - bx * ay
  }
  const sign = Math.sign(area2)
  const inside = (px, py) => {
    for (let i = 0; i < n; i++) {
      const [ax, ay] = corners[i],
        [bx, by] = corners[(i + 1) % n]
      if (sign * ((bx - ax) * (py - ay) - (by - ay) * (px - ax)) < 0) return false
    }
    return true
  }
  let sum = 0,
    sum2 = 0,
    count = 0
  for (let y = y0; y <= Math.min(h - 1, y1); y++)
    for (let x = x0; x <= Math.min(w - 1, x1); x++) {
      if (!inside(x, y)) continue
      const v = img[y * w + x]
      sum += v
      sum2 += v * v
      count++
    }
  const mean = count ? sum / count : NaN
  return { mean, std: count ? Math.sqrt(Math.max(0, sum2 / count - mean * mean)) : NaN, count }
}

// The irradiance a calibration panel of known reflectance (albedo, 0–1) shows: the
// radiance it reflects, E = π·L/ρ (panel.py irradiance_mean).
export const panelIrradiance = (radianceMean, albedo) => (Math.PI * radianceMean) / albedo

// Radiance → reflectance under irradiance E (W/m²/nm).
export const reflectanceFactor = (irradiance) => Math.PI / irradiance

// Firmware from which the DLS 2's horizontal irradiance is right (metadata.py
// horizontal_irradiance_valid); RedEdge-P and Altum-PT always are.
const GOOD_FIRMWARE = { 'Altum': '1.2.3', 'RedEdge': '5.1.7', 'RedEdge-M': '5.1.7' }
const versionAtLeast = (v, min) => {
  const a = String(v ?? '')
    .replace(/^v/, '')
    .split(/[.-]/)
    .map((x) => parseInt(x, 10) || 0)
  const b = min.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== b[i]) return (a[i] ?? 0) > b[i]
  return true
}

// The ground irradiance the downwelling light sensor (DLS 2) measured for this band, or
// null when there is none (DLS 1 needs the sun's position, not modelled here). The
// camera's horizontal irradiance where its firmware computes it right, else
// direct·sin(sun elevation) + scattered (image.py compute_horizontal_irradiance_dls2).
export function dlsIrradiance(band, model = '') {
  const irr = band?.irradiance
  if (!irr || band.thermal) return null
  const good = GOOD_FIRMWARE[model]
  const horizontalValid = irr.horizontal != null && (!good || versionAtLeast(band.firmware, good))
  if (horizontalValid && irr.horizontal > 0) return irr.horizontal
  if (irr.direct > 0 && irr.scattered != null && irr.solarElevation != null)
    return irr.direct * Math.sin(irr.solarElevation) + irr.scattered
  return null
}

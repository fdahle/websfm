// The reflectance map of a multispectral camera (plan-after-0.7 ▸ MSP-4): one Float32
// plane per band on the DEM, in reflectance (0–1; °C for a thermal band; radiance
// when there is nothing to calibrate with), NaN where no photo sees the ground.
// Pure: the worker loads the photos (workers/ops/reflectance.js).
//
// Each ground cell is assigned to one capture, the one whose reference-band photo sees it
// nearest its principal point (the most nadir view, as a mosaic of one photo per cell),
// and every band samples that capture's own photo of it: the lenses fire together, so a
// capture's band photos see the cell from nearly the same place. A cell is read straight
// from the raw DN, through the band's lens distortion (makeSampleMap), and the
// radiometric model of the band (core/radiometry/micasense.js) times the photo's
// calibration factor. Cells are not checked for occlusion: a reflectance map is made of
// open ground (fields, canopy), where the nadir view sees what the DEM describes.

import { vignetteFn, exposureSeconds } from '../radiometry/micasense.js'

// The output grid over the DEM's extent at `gsd` (frame units), and the height under
// each of its cells: the DEM's own cells when gsd equals its, else a bilinear sample.
export function reflectanceGeometry(dem, gsd) {
  const g = gsd > 0 ? gsd : dem.gsd
  const width = Math.max(1, Math.round((dem.width * dem.gsd) / g))
  const height = Math.max(1, Math.round((dem.height * dem.gsd) / g))
  return { width, height, gsd: g, originX: dem.originX, originY: dem.originY }
}

// The DEM height at frame (x, y): bilinear over the four nearest cells that have one
// (weights renormalised), NaN where none has.
export function demHeightAt(dem, x, y) {
  const fx = (x - dem.originX) / dem.gsd - 0.5,
    fy = (dem.originY - y) / dem.gsd - 0.5
  const c0 = Math.floor(fx),
    r0 = Math.floor(fy)
  const ax = fx - c0,
    ay = fy - r0
  let sum = 0,
    w = 0
  for (let dr = 0; dr < 2; dr++)
    for (let dc = 0; dc < 2; dc++) {
      const c = c0 + dc,
        r = r0 + dr
      if (c < 0 || r < 0 || c >= dem.width || r >= dem.height) continue
      const i = r * dem.width + c
      if (dem.mask && !dem.mask[i]) continue
      const z = dem.data[i]
      if (!Number.isFinite(z)) continue
      const k = (dc ? ax : 1 - ax) * (dr ? ay : 1 - ay)
      sum += k * z
      w += k
    }
  return w > 1e-9 ? sum / w : NaN
}

// Where a photo sees SfM point P: pinhole pixel (u, v) and the score of the view (squared
// normalised distance from the principal point), or null outside the frame (a margin of
// `margin` px) or behind the camera.
export function viewOf(photo, P, margin = 2) {
  const { R, t, K } = photo
  const z = R[2][0] * P[0] + R[2][1] * P[1] + R[2][2] * P[2] + t[2]
  if (!(z > 0)) return null
  const x = (R[0][0] * P[0] + R[0][1] * P[1] + R[0][2] * P[2] + t[0]) / z
  const y = (R[1][0] * P[0] + R[1][1] * P[1] + R[1][2] * P[2] + t[1]) / z
  const u = K.fx * x + K.cx,
    v = K.fy * y + K.cy
  if (u < margin || v < margin || u > photo.width - 1 - margin || v > photo.height - 1 - margin) return null
  return { u, v, score: x * x + y * y }
}

// The value of one band at raw pixel (x, y) of a photo whose DN plane is `dn` (w × h):
// bilinear DN, then that band's radiometric model times `factor`. NaN off the photo.
// `cal` = { band (bandMetadata), model, factor } from radiometryOf.
export function valueAt(dn, w, h, x, y, cal) {
  if (!(x >= 0 && y >= 0 && x <= w - 1 && y <= h - 1)) return NaN
  const x0 = Math.min(w - 2, Math.floor(x)),
    y0 = Math.min(h - 2, Math.floor(y))
  const ax = x - x0,
    ay = y - y0
  const i = y0 * w + x0
  const d = (1 - ay) * ((1 - ax) * dn[i] + ax * dn[i + 1]) + ay * ((1 - ax) * dn[i + w] + ax * dn[i + w + 1])
  return cal.toValue(d, x, y)
}

// A band photo's DN → value function: the radiometric model of its band, scaled by the
// photo's calibration factor (π/E for the sun sensor, the panel's albedo/radiance, or 1
// for radiance). The thermal band gives °C. w × h: the raw photo's size.
export function radiometryOf(band, model, factor, w, h) {
  if (band.thermal) return { toValue: (d) => d / 100 - 273.15 }
  const [a1, a2, a3] = band.radiometricCal
  const exposure = exposureSeconds(band, model)
  const black = band.blackLevel ?? 0
  const scale = (a1 / (band.gain * exposure * 2 ** band.bits)) * factor
  const vig = vignetteFn(band, w, h)
  return {
    toValue: (d, x, y) => {
      const v = d - black
      if (!(v > 0)) return 0
      return vig(x, y) * (1 / (1 + (a2 * y) / exposure - a3 * y)) * v * scale
    },
  }
}

// The captures that may see a block, from a lattice of its cells: those whose scoring
// photo sees any lattice point. `cellP(c, r)` → SfM point or null (no height).
export function blockCaptures(captures, block, cellP, lattice = 12) {
  const pts = []
  for (let j = 0; j <= lattice; j++)
    for (let i = 0; i <= lattice; i++) {
      const c = block.col0 + Math.min(block.width - 1, Math.round((i / lattice) * (block.width - 1)))
      const r = block.row0 + Math.min(block.height - 1, Math.round((j / lattice) * (block.height - 1)))
      const P = cellP(c, r)
      if (P) pts.push(P)
    }
  // A generous margin: a photo that sees no lattice point may still see a cell between them.
  return captures.filter((cap) => pts.some((P) => viewOf(cap.scoring, P, -cap.scoring.width / lattice)))
}

// Render one block: `captures` [{ scoring: photo, photos: [photo | null per band] }]
// (those blockCaptures found), `photoData(photo)` → { dn, width, height } of the loaded
// raw photo, `cellP(c, r)` → SfM point or null. Each photo: { R, t, K, width, height
// (the pinhole frame), sampleMap (pinhole px → raw px, or null), cal: radiometryOf(…) }.
// Returns { data: Float32Array (w × h × nBands, pixel-interleaved), covered }.
export function renderReflectanceBlock(block, captures, nBands, cellP, photoData) {
  const { width: bw, height: bh, col0, row0 } = block
  const data = new Float32Array(bw * bh * nBands).fill(NaN)
  let covered = 0
  for (let r = 0; r < bh; r++)
    for (let c = 0; c < bw; c++) {
      const P = cellP(col0 + c, row0 + r)
      if (!P) continue
      let best = null,
        bestScore = Infinity
      for (const cap of captures) {
        const v = viewOf(cap.scoring, P)
        if (v && v.score < bestScore) {
          bestScore = v.score
          best = cap
        }
      }
      if (!best) continue
      covered++
      const o = (r * bw + c) * nBands
      for (let b = 0; b < nBands; b++) {
        const photo = best.photos[b]
        if (!photo) continue
        const v = viewOf(photo, P, 0)
        if (!v) continue
        const raw = photo.sampleMap ? photo.sampleMap(v.u, v.v) : { x: v.u, y: v.v }
        const img = photoData(photo)
        data[o + b] = valueAt(img.dn, img.width, img.height, raw.x, raw.y, photo.cal)
      }
    }
  return { data, covered }
}

// How each band photo is calibrated (Reflectance map ▸ Calibration):
//   'panel'      factor = albedo / L_panel, the panel's radiance in that band
//   'dls'        factor = π / E, the sun sensor's irradiance at this photo
//   'panel+dls'  the panel's factor, carried to this photo by the sun sensor's change:
//                (albedo / L_panel) · (E_panel / E)
//   'radiance'   factor 1 (radiance, W/m²/sr/nm)
// 'auto' takes the first the data allows, in the order panel+dls, panel, dls, radiance.
// `panels`: per band key, { albedo, radiance (mean over the panel captures), irradiance
// (the sun sensor's at them, or null) }. `irradiance`: the photo's sun-sensor reading.
export function resolveCalibration(mode, { havePanel, haveDls }) {
  if (mode !== 'auto') return mode
  if (havePanel && haveDls) return 'panel+dls'
  if (havePanel) return 'panel'
  if (haveDls) return 'dls'
  return 'radiance'
}

export function calibrationFactor(mode, panel, irradiance) {
  if (mode === 'radiance') return 1
  if (mode === 'dls') return irradiance > 0 ? Math.PI / irradiance : NaN
  if (!(panel?.radiance > 0)) return NaN
  const k = panel.albedo / panel.radiance
  if (mode === 'panel') return k
  // panel+dls
  return panel.irradiance > 0 && irradiance > 0 ? (k * panel.irradiance) / irradiance : k
}

// The ground sample distance the reference band's photos have over the DEM (frame
// units): the median of each photo's height above the ground under it over its focal
// length. `centres`: the photos' centres in the frame, `fx`: their focal lengths.
export function nativeGsd(dem, centres, fx) {
  const v = []
  centres.forEach((C, i) => {
    const z = demHeightAt(dem, C[0], C[1])
    if (Number.isFinite(z) && C[2] > z && fx[i] > 0) v.push((C[2] - z) / fx[i])
  })
  if (!v.length) return null
  v.sort((a, b) => a - b)
  return v[v.length >> 1]
}

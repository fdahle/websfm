// SAT-5 acceptance: each image's fitted reseau transform (scan px → camera mm) against
// the synthetic block's truth (synth_sat.py film_warp / scan_to_film, ported here).
// Error in scan pixels at random points inside the frame; the target is < 0.5 px.
import { readFile } from 'node:fs/promises'
import { applyFiducialTransform } from '../../../src/core/sfm/fiducialCalibration.js'

function filmWarp(film, s, x, y) {
  if (!film || !film.amp_mm) return [0, 0]
  const A = film.amp_mm, [p0, p1] = film.phase
  const u = x / (s.film_w / 2), v = y / (s.film_h / 2)
  return [A * (0.6 * Math.sin(Math.PI * u + p0) * Math.cos(0.5 * Math.PI * v) + 0.4 * u * v),
    A * (0.6 * Math.cos(0.5 * Math.PI * u) * Math.sin(Math.PI * v + p1) + 0.3 * (u * u - 1 / 3))]
}
function scanToFilm(film, s, u, v) {
  const th = (film?.rot_deg ?? 0) * Math.PI / 180, [sx, sy] = film?.shift_px ?? [0, 0]
  const xr = (u - s.W / 2 - sx) * s.pitch, yr = -(v - s.H / 2 - sy) * s.pitch
  const qx = Math.cos(th) * xr + Math.sin(th) * yr, qy = -Math.sin(th) * xr + Math.cos(th) * yr
  let x = qx, y = qy
  for (let k = 0; k < 4; k++) { const [dx, dy] = filmWarp(film, s, x, y); x = qx - dx; y = qy - dy }
  return [x, y]
}

export async function reseauTruthCheck(truthPath, fits, { samples = 2000, inset = 0.03 } = {}) {
  const t = JSON.parse(await readFile(truthPath, 'utf8'))
  const s = { W: t.W, H: t.H, pitch: t.config.pitch_mm, film_w: t.config.film_w_mm, film_h: t.config.film_h_mm }
  const out = {}
  let seed = 11
  const rnd = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296 }
  for (const fit of fits) {
    const cam = t.cameras.find((c) => c.name === fit.name)
    if (!cam) continue
    let sum = 0, worst = 0, sumAffine = 0
    for (let k = 0; k < samples; k++) {
      const u = (inset + (1 - 2 * inset) * rnd()) * s.W, v = (inset + (1 - 2 * inset) * rnd()) * s.H
      const [x, y] = scanToFilm(cam.film, s, u, v)
      const m = applyFiducialTransform({ x: u, y: v }, fit)
      const a = applyFiducialTransform({ x: u, y: v }, { forward: fit.forward })
      const e = Math.hypot(m.x - x, m.y - y) / s.pitch
      sum += e * e; worst = Math.max(worst, e)
      sumAffine += (Math.hypot(a.x - x, a.y - y) / s.pitch) ** 2
    }
    out[fit.name] = { rmsPx: Math.sqrt(sum / samples), maxPx: worst, affineOnlyRmsPx: Math.sqrt(sumAffine / samples) }
  }
  return out
}

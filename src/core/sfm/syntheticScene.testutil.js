// Synthetic SfM scenes for tests (imported by *.test.js only; never by app code).
//
// `aerialBlock` builds a nadir photo block over gently rolling terrain, shaped like
// what the store hands the SfM worker: per-image keypoints in native pixels (with
// lens distortion, pixel noise, distractor keypoints and a shuffled order), packed
// matches with dropouts and outliers, uint8 descriptors for guided extension, GCPs
// in the viewer's pixel-edge convention and optional camera priors. Everything comes
// from one seeded PRNG, so a scene is identical on every run.

import { resolveK } from './reconstruction.js'
import { distortPixel } from './distortion.js'
import { packMatchPairs, Uint32PairList } from './matchCodec.js'
import { canonicalFrame } from './fiducials.js'

export function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const mul = (A, B) => Array.from({ length: 3 }, (_, i) => Array.from({ length: 3 }, (_, j) =>
  A[i][0] * B[0][j] + A[i][1] * B[1][j] + A[i][2] * B[2][j]))
const T = (M) => [[M[0][0], M[1][0], M[2][0]], [M[0][1], M[1][1], M[2][1]], [M[0][2], M[1][2], M[2][2]]]
const mv = (M, v) => [0, 1, 2].map((i) => M[i][0] * v[0] + M[i][1] * v[1] + M[i][2] * v[2])
const skew = (t) => [[0, -t[2], t[1]], [t[2], 0, -t[0]], [-t[1], t[0], 0]]
const rotX = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[1, 0, 0], [0, c, -s], [0, s, c]] }
const rotY = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, 0, s], [0, 1, 0], [-s, 0, c]] }
const rotZ = (a) => { const c = Math.cos(a), s = Math.sin(a); return [[c, -s, 0], [s, c, 0], [0, 0, 1]] }
// World Z up, camera looking straight down: x_cam = X, y_cam = −Y, z_cam = −Z.
const NADIR = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]

/**
 * @param {object} o
 * @param {number} o.seed
 * @param {number} o.rows / o.cols        camera grid
 * @param {number} [o.nPoints]            terrain points
 * @param {object} [o.dist]               true lens distortion {k1,k2,…} applied to keypoints
 * @param {boolean} [o.calibrated]        give the sensor the true K + distortion (else EXIF only)
 * @param {number} [o.focalError]         EXIF focal / true focal (uncalibrated only)
 * @param {number} [o.gcps]               number of GCPs to mark
 * @param {boolean} [o.priors]            camera position priors
 * @param {object[]} [o.blocks]           extra blocks [{ rows, cols, offsetX, offsetY }]; no pairs across blocks
 * @param {string} [o.prefix]             uuid prefix
 * @param {boolean} [o.film]              film scans: keypoints in per-image scan space,
 *                                        fiducial detections + a calibrated layout
 */
export function aerialBlock({
  seed, rows, cols, nPoints = 3000, dist = { k1: -0.05, k2: 0.008 }, calibrated = false,
  focalError = 1.04, gcps = 0, priors = false, blocks = [], prefix = 'im',
  noisePx = 0.35, distractorFrac = 0.25, keepFrac = 0.85, outlierFrac = 0.03, film = false,
}) {
  const rng = mulberry32(seed)
  const gauss = () => {
    const u = Math.max(1e-12, rng()), v = rng()
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v)
  }
  const meta = { width: 1600, height: 1200, focalLength35: 28 }
  const nominal = resolveK(meta)
  const fxTrue = calibrated ? nominal.fx : nominal.fx / focalError
  const Ktrue = { fx: fxTrue, fy: fxTrue, cx: meta.width / 2 + 3.5, cy: meta.height / 2 - 2.5 }
  // Film: a 10 µm canonical frame around four corner marks; the scanner places each
  // frame with its own rotation and offset, which the fiducial fit must remove.
  const PITCH = 0.01
  const fid = film ? {
    marks: [[-7.6, -5.6], [7.6, -5.6], [7.6, 5.6], [-7.6, 5.6]].map(([xMm, yMm], i) => ({ id: `F${i + 1}`, xMm, yMm })),
    ppxMm: 0, ppyMm: 0, focalMm: fxTrue * PITCH,
  } : null
  const frame = film ? canonicalFrame(fid, PITCH) : null
  if (film) { Ktrue.cx = frame.K.cx; Ktrue.cy = frame.K.cy; dist = {} }
  const SLOTS = ['corner-tl', 'corner-tr', 'corner-br', 'corner-bl']
  const fidCal = film ? { ...fid, transform: 'affine', slotMap: Object.fromEntries(SLOTS.map((sl, i) => [sl, fid.marks[i].id])) } : null
  const H = 60, B = 14, S = 18

  const blockSpecs = [{ rows, cols, offsetX: 0, offsetY: 0 }, ...blocks]
  const cams = []
  blockSpecs.forEach((b, bi) => {
    for (let r = 0; r < b.rows; r++) {
      for (let c = 0; c < b.cols; c++) {
        const C = [b.offsetX + c * B + gauss() * 0.6, b.offsetY + r * S + gauss() * 0.6, H + gauss() * 1.5]
        const tilt = mul(rotZ((r % 2 ? Math.PI : 0) + gauss() * 0.05),
          mul(rotX(gauss() * 0.06), rotY(gauss() * 0.06)))
        const R = mul(T(tilt), NADIR)
        const t = mv(R, C).map((v) => -v)
        cams.push({ uuid: `${prefix}${String(cams.length).padStart(3, '0')}`, block: bi, R, t, C })
      }
    }
  })

  const minX = Math.min(...cams.map((c) => c.C[0])) - 40, maxX = Math.max(...cams.map((c) => c.C[0])) + 40
  const minY = Math.min(...cams.map((c) => c.C[1])) - 35, maxY = Math.max(...cams.map((c) => c.C[1])) + 35
  const world = []
  const nTotal = nPoints * blockSpecs.length
  while (world.length < nTotal) {
    const X = minX + rng() * (maxX - minX), Y = minY + rng() * (maxY - minY)
    // Only keep points near some camera (blocks can be far apart).
    if (!cams.some((c) => Math.abs(c.C[0] - X) < 50 && Math.abs(c.C[1] - Y) < 40)) continue
    const Z = 3 * Math.sin(X / 20) * Math.cos(Y / 15) + 1.5 * Math.sin(X / 7 + Y / 9) + gauss() * 0.3
    world.push([X, Y, Z])
  }
  const colorOf = world.map(() => [Math.floor(rng() * 256), Math.floor(rng() * 256), Math.floor(rng() * 256)])
  const descOf = world.map(() => { const d = new Uint8Array(128); for (let i = 0; i < 128; i++) d[i] = Math.floor(rng() * 60); return d })

  const project = (cam, X) => {
    const c = mv(cam.R, X).map((v, i) => v + cam.t[i])
    if (c[2] <= 0.5) return null
    const u = Ktrue.fx * c[0] / c[2] + Ktrue.cx, v = Ktrue.fy * c[1] / c[2] + Ktrue.cy
    const d = distortPixel(u, v, Ktrue, dist)
    if (d.x < 8 || d.y < 8 || d.x > meta.width - 8 || d.y > meta.height - 8) return null
    return d
  }

  const images = []
  const kpOfWorld = [] // per image: Map worldIdx → kpIdx
  for (const cam of cams) {
    const th = film ? (rng() - 0.5) * 0.1 : 0, ox = film ? 30 + rng() * 60 : 0, oy = film ? 30 + rng() * 60 : 0
    const mmToScan = (xMm, yMm) => ({
      x: (Math.cos(th) * xMm - Math.sin(th) * yMm) / PITCH + ox + 800,
      y: (Math.sin(th) * xMm + Math.cos(th) * yMm) / PITCH + oy + 600,
    })
    const toScan = film
      ? (x, y) => mmToScan(frame.originX + x * PITCH, frame.originY + y * PITCH)
      : (x, y) => ({ x, y })
    const obs = []
    world.forEach((X, wi) => {
      const p = project(cam, X)
      if (p) obs.push({ wi, x: p.x + gauss() * noisePx, y: p.y + gauss() * noisePx })
    })
    const nDistract = Math.floor(obs.length * distractorFrac)
    for (let i = 0; i < nDistract; i++) obs.push({ wi: -1, x: 8 + rng() * (meta.width - 16), y: 8 + rng() * (meta.height - 16) })
    for (let i = obs.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [obs[i], obs[j]] = [obs[j], obs[i]] }
    const map = new Map()
    const descU8 = new Uint8Array(obs.length * 128)
    const keypoints = obs.map((o, k) => {
      if (o.wi >= 0) {
        map.set(o.wi, k)
        const base = descOf[o.wi]
        for (let i = 0; i < 128; i++) descU8[k * 128 + i] = Math.max(0, Math.min(255, base[i] + Math.round(gauss() * 3)))
      } else {
        for (let i = 0; i < 128; i++) descU8[k * 128 + i] = Math.floor(rng() * 60)
      }
      // A few keypoints carry no colour, as on a grey image.
      const color = rng() < 0.02 ? undefined : (o.wi >= 0 ? colorOf[o.wi] : [128, 128, 128])
      const p = toScan(o.x, o.y)
      return { x: p.x, y: p.y, color }
    })
    kpOfWorld.push(map)
    images.push({
      uuid: cam.uuid, name: `${cam.uuid}.jpg`, kpStatus: 'done', detectScale: null,
      sensorId: 'sensor-1', keypoints, descU8,
      meta: film ? { width: 1800, height: 1400 } : { ...meta },
      ...(film ? { fiducialDetections: fid.marks.map((m, i) => {
        const q = mmToScan(m.xMm, m.yMm)
        return { slot: SLOTS[i], px: q.x + gauss() * 0.2, py: q.y + gauss() * 0.2, confidence: 1 }
      }) } : {}),
      sensor: film ? { kind: 'film', fiducialCalibration: fidCal } : calibrated
        ? { focal: Ktrue.fx, focalUnit: 'px', cx: Ktrue.cx, cy: Ktrue.cy, width: meta.width, height: meta.height,
            k1: dist.k1 ?? 0, k2: dist.k2 ?? 0, k3: 0, p1: 0, p2: 0, distortionModel: 'radial2', kind: 'digital' }
        : null,
    })
  }

  // Ktrue-pinhole fundamental: F = K⁻ᵀ [t]x R K⁻¹.
  const Kinv = [[1 / Ktrue.fx, 0, -Ktrue.cx / Ktrue.fx], [0, 1 / Ktrue.fy, -Ktrue.cy / Ktrue.fy], [0, 0, 1]]
  const fundamental = (a, b) => {
    const Rrel = mul(b.R, T(a.R))
    const ta = mv(Rrel, a.t)
    const trel = b.t.map((v, k) => v - ta[k])
    return mul(mul(T(Kinv), mul(skew(trel), Rrel)), Kinv)
  }
  const pairs = []
  for (let a = 0; a < cams.length; a++) {
    for (let b = a + 1; b < cams.length; b++) {
      if (cams[a].block !== cams[b].block) continue
      const list = []
      for (const [wi, ka] of kpOfWorld[a]) {
        const kb = kpOfWorld[b].get(wi)
        if (kb != null && rng() < keepFrac) list.push([ka, kb])
      }
      if (list.length < 25) continue
      const nOut = Math.floor(list.length * outlierFrac)
      for (let i = 0; i < nOut; i++) {
        list.push([Math.floor(rng() * images[a].keypoints.length), Math.floor(rng() * images[b].keypoints.length)])
      }
      list.sort((p, q) => p[0] - q[0] || p[1] - q[1])
      // Keep the first match per keypoint on each side (a matcher's cross-check).
      const usedA = new Set(), usedB = new Set(), uniq = []
      for (const [ia, ib] of list) {
        if (usedA.has(ia) || usedB.has(ib)) continue
        usedA.add(ia); usedB.add(ib); uniq.push([ia, ib])
      }
      pairs.push({
        idA: cams[a].uuid, idB: cams[b].uuid, F: fundamental(cams[a], cams[b]),
        matches: new Uint32PairList(packMatchPairs(uniq)), inlierCount: uniq.length,
        weak: uniq.length < 45, status: 'done',
      })
    }
  }

  const gcpList = []
  for (let g = 0; g < gcps; g++) {
    // Spread the GCPs over the first block.
    const cam = cams[Math.floor((g + 0.5) / gcps * rows * cols)]
    const X = [cam.C[0] + gauss() * 4, cam.C[1] + gauss() * 4, 0]
    X[2] = 3 * Math.sin(X[0] / 20) * Math.cos(X[1] / 15) + 1.5 * Math.sin(X[0] / 7 + X[1] / 9)
    const observations = []
    for (const c of cams) {
      const p = project(c, X)
      if (p) observations.push({ uuid: c.uuid, px: p.x + 0.5 + gauss() * 0.3, py: p.y + 0.5 + gauss() * 0.3, accuracyX: 0.5, accuracyY: 0.5 })
    }
    gcpList.push({ id: `g${g}`, name: `GCP${g}`, role: 'control', x: X[0], y: X[1], z: X[2],
      accuracyX: 0.02, accuracyY: 0.02, accuracyZ: 0.03, observations })
  }

  const cameraPriors = priors
    ? cams.map((c) => ({ uuid: c.uuid, x: c.C[0] + gauss() * 0.05, y: c.C[1] + gauss() * 0.05, z: c.C[2] + gauss() * 0.08,
      accuracyX: 0.05, accuracyY: 0.05, accuracyZ: 0.08 }))
    : []

  return { images, pairs, gcps: gcpList, cameraPriors, truth: { cams, world, Ktrue } }
}

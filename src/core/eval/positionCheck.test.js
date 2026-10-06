import { describe, it, expect } from 'vitest'

import { cameraPositionCheck, geodeticToEcef, makeEnuFrame } from './positionCheck.js'

const I = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]

// A 4×4 grid of cameras 30 m apart near Eclépens (the quarry set), 300 m up.
function scene({ noise = () => 0, bend = 0 } = {}) {
  const lat0 = 46.655, lon0 = 6.537
  // Meridian and prime-vertical radii of WGS84, so the grid is metric to sub-mm.
  const f = 1 / 298.257223563, e2 = f * (2 - f), sl = Math.sin(lat0 * Math.PI / 180)
  const M = 6378137 * (1 - e2) / (1 - e2 * sl * sl) ** 1.5, N = 6378137 / Math.sqrt(1 - e2 * sl * sl)
  const mPerDegLat = M * Math.PI / 180, mPerDegLon = N * Math.cos(lat0 * Math.PI / 180) * Math.PI / 180
  const cameras = new Map(), positions = new Map()
  let k = 0
  for (let i = 0; i < 4; i++) {
    for (let j = 0; j < 4; j++) {
      const e = i * 30, n = j * 30, u = `c${k++}`
      // SfM frame: an arbitrary scale (0.1) and offset; centre C = −Rᵀt with R = I.
      const C = [0.1 * e + 5, 0.1 * n - 2, 0.1 * (bend * ((e - 45) ** 2 + (n - 45) ** 2))]
      cameras.set(u, { R: I, t: [-C[0], -C[1], -C[2]] })
      positions.set(u, { lat: lat0 + n / mPerDegLat, lon: lon0 + e / mPerDegLon, alt: 780 + noise() })
    }
  }
  return { cameras, positions }
}

describe('cameraPositionCheck', () => {
  it('ENU frame is metric and centred', () => {
    const toEnu = makeEnuFrame(46.655, 6.537, 780)
    const p = toEnu(geodeticToEcef(46.655 + 1 / 111_200, 6.537, 780))
    expect(p[0]).toBeCloseTo(0, 2)
    expect(p[1]).toBeGreaterThan(0.99); expect(p[1]).toBeLessThan(1.01)
  })

  it('a correct model matches its GNSS positions up to the gauge', () => {
    const { cameras, positions } = scene()
    const r = cameraPositionCheck(cameras, positions)
    expect(r.count).toBe(16)
    expect(r.scale).toBeCloseTo(10, 1)
    expect(r.rms3d).toBeLessThan(0.002) // earth curvature over 90 m is sub-mm
  })

  it('reports a domed model as vertical residuals', () => {
    const { cameras, positions } = scene({ bend: 0.0005 })
    const r = cameraPositionCheck(cameras, positions)
    expect(r.rmsV).toBeGreaterThan(0.3)
    expect(r.rmsV).toBeGreaterThan(5 * r.rmsH)
  })

  it('needs three positioned cameras', () => {
    const { cameras } = scene()
    expect(cameraPositionCheck(cameras, new Map())).toBeNull()
  })
})

describe('lever arm and checkpoints', () => {
  it('recovers an antenna offset and reports a checkpoint at the right place', async () => {
    const { gcpCheck } = await import('./positionCheck.js')
    const { cameras, positions } = scene()
    // Cameras look straight down (R = diag(1,−1,−1)): camera x = east, y = south, z = down.
    const Rdown = [[1, 0, 0], [0, -1, 0], [0, 0, -1]]
    const arm = [0.4, -0.2, -0.05] // metres in the camera frame
    for (const [u, c] of cameras) {
      const C = [-c.t[0], -c.t[1], -c.t[2]] // R was I: C = −t
      // Same centre under the new rotation: t = −R·C.
      cameras.set(u, { R: Rdown, t: Rdown.map((row) => -(row[0] * C[0] + row[1] * C[1] + row[2] * C[2])) })
      // Positions are the antenna: centre + Rᵀ·arm, in metres = east +0.4, north +0.2, up +0.05.
      const p = positions.get(u)
      positions.set(u, { lat: p.lat + 0.2 / 111_150, lon: p.lon + 0.4 / 76_300, alt: p.alt + 0.05 })
    }
    const without = cameraPositionCheck(cameras, positions)
    const withArm = cameraPositionCheck(cameras, positions, { leverArm: arm })
    expect(withArm.rms3d).toBeLessThan(0.01)
    expect(without.rms3d).toBeLessThan(0.01) // a pure translation for nadir images — absorbed
    // A checkpoint 45 m east / north of the first camera, on the ground (SfM z = −30).
    const sfm = [0.1 * 45 + 5, 0.1 * 45 - 2, -30]
    const fit = withArm
    const enuGcp = [45, 45, -300]
    const lat = 46.655 + enuGcp[1] / 111_150, lon = 6.537 + enuGcp[0] / 76_300
    const r = gcpCheck(fit, [{ label: 'A', sfm, lat, lon, h: 780 + enuGcp[2] }, { label: 'B', sfm: null, lat, lon, h: 0 }])
    expect(r.count).toBe(1)
    expect(r.of).toBe(2)
    expect(Math.abs(r.rows[0].dU)).toBeLessThan(0.2)
  })
})

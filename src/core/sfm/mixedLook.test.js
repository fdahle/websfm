import { describe, expect, it } from 'vitest'
import { estimateUpFromCameras, groundUp, mixedLookUp, viewGroups } from './geometry.js'
import { sceneUpFromCameras, buildLocalFrame } from '../products/projection.js'
import { pointView } from '../products/pointView.ts'

// A synthetic trimetrogon flight, turned by an arbitrary rotation Q so nothing lines up
// with the axes: cameras at 1000 m along +x, verticals looking straight down, left
// obliques 60° off nadir to the left (+y), over a ground with 30 m of relief. The true
// up is Q·(0, 0, 1).
const rot = (ax, ay, az) => {
  const [cx, sx, cy, sy, cz, sz] = [Math.cos(ax), Math.sin(ax), Math.cos(ay), Math.sin(ay), Math.cos(az), Math.sin(az)]
  const X = [
    [1, 0, 0],
    [0, cx, -sx],
    [0, sx, cx],
  ]
  const Y = [
    [cy, 0, sy],
    [0, 1, 0],
    [-sy, 0, cy],
  ]
  const Z = [
    [cz, -sz, 0],
    [sz, cz, 0],
    [0, 0, 1],
  ]
  const mul = (A, B) => A.map((r) => [0, 1, 2].map((j) => r[0] * B[0][j] + r[1] * B[1][j] + r[2] * B[2][j]))
  return mul(Z, mul(Y, X))
}
const Q = rot(0.7, -1.1, 2.3)
const mv = (M, v) => M.map((r) => r[0] * v[0] + r[1] * v[1] + r[2] * v[2])
const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
const trueUp = mv(Q, [0, 0, 1])
const angle = (a, b) => {
  const n = Math.hypot(...a) * Math.hypot(...b)
  return (Math.acos(Math.min(1, Math.abs(a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / n)) * 180) / Math.PI
}
const signedAngle = (a, b) => {
  const n = Math.hypot(...a) * Math.hypot(...b)
  return (Math.acos(Math.min(1, Math.max(-1, (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) / n))) * 180) / Math.PI
}

// A camera at world centre C looking along `look` (world, before Q), flying along +x.
function camera(C, look) {
  const z = look.map((v) => v / Math.hypot(...look))
  const x = [1, 0, 0]
  const y = cross(z, x)
  const R = [x, y, z].map((row) => mv(Q, row)) // rows are world axes: turn them with Q
  const Cq = mv(Q, C)
  return { R, t: R.map((r) => -(r[0] * Cq[0] + r[1] * Cq[1] + r[2] * Cq[2])) }
}
const tilt = (deg) => [0, Math.sin((deg * Math.PI) / 180), -Math.cos((deg * Math.PI) / 180)]
const strip = (n, look, y0 = 0) => Array.from({ length: n }, (_, i) => camera([i * 900, y0, 1000], look))
// Ground: a 15 × 10 km sheet with gentle relief, seeded so the test is repeatable.
function ground() {
  let seed = 7
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
  const pos = []
  for (let i = 0; i < 3000; i++) {
    const p = mv(Q, [-2000 + 15000 * Math.abs(rnd()), -3000 + 10000 * Math.abs(rnd()), 30 * rnd()])
    pos.push(...p)
  }
  return { pos: Float64Array.from(pos), length: 3000 }
}

describe('mixed vertical / oblique looks', () => {
  const pts = ground()
  // Rachel's first run kept 12 left obliques and 4 verticals. One flight line, the
  // cameras of an exposure side by side: the centres make no plane, so the camera-plane
  // reading (planeUpOverride) cannot help, as it could not on Rachel's bent model.
  const mostlyObliques = [...strip(12, tilt(60)), ...strip(4, tilt(2))]

  it('groups viewing directions by look', () => {
    const dirs = mostlyObliques.map((c) => c.R[2])
    expect(viewGroups(dirs).map((g) => g.n)).toEqual([12, 4])
  })

  it('finds the ground plane, pointing at the cameras', () => {
    expect(signedAngle(groundUp(pts, mostlyObliques), trueUp)).toBeLessThan(1)
  })

  it('takes up from the vertical group when the obliques outnumber it', () => {
    // Without the cloud the main look is the obliques': ~60° off.
    expect(angle(sceneUpFromCameras(mostlyObliques).up, trueUp)).toBeGreaterThan(50)
    const how = sceneUpFromCameras(mostlyObliques, pts)
    expect(how.source).toBe('vertical-group')
    expect(how.cameras).toBe(4)
    expect(signedAngle(how.up, trueUp)).toBeLessThan(3) // the verticals' 2° tilt
    // The viewer's reading and the products' frame agree.
    expect(signedAngle(estimateUpFromCameras(mostlyObliques, { aerial: true, points: pts }), trueUp)).toBeLessThan(3)
    const pointList = Array.from({ length: pts.length }, (_, i) => ({
      x: pts.pos[3 * i],
      y: pts.pos[3 * i + 1],
      z: pts.pos[3 * i + 2],
    }))
    expect(signedAngle(buildLocalFrame(mostlyObliques, pointList).up, trueUp)).toBeLessThan(3)
  })

  // The products worker hands the frame a pointView (an iterable with a length, no
  // index): the DEM and the orthophoto of a local frame build from it.
  it('reads the cloud as the products worker passes it', () => {
    const view = pointView({ pos: Float32Array.from(pts.pos), count: pts.length })
    expect(signedAngle(groundUp(view, mostlyObliques), trueUp)).toBeLessThan(1)
    expect(signedAngle(buildLocalFrame(mostlyObliques, view).up, trueUp)).toBeLessThan(3)
  })

  it('takes the ground plane when every camera looks obliquely', () => {
    const how = sceneUpFromCameras(strip(10, tilt(60)), pts)
    expect(how.source).toBe('ground-plane')
    expect(signedAngle(how.up, trueUp)).toBeLessThan(1)
  })

  it('leaves a nadir block, a balanced TMA block and a mild oblique set alone', () => {
    // Nadir over a 20° slope (a terrain-following flight): the cameras still say up.
    const slope = { pos: Float64Array.from(pts.pos), length: pts.length }
    const S = rot(0, (20 * Math.PI) / 180, 0)
    const QT = Q.map((_, i) => Q.map((r) => r[i]))
    for (let i = 0; i < slope.length; i++) {
      const p = mv(Q, mv(S, mv(QT, [slope.pos[3 * i], slope.pos[3 * i + 1], slope.pos[3 * i + 2]])))
      slope.pos.set(p, 3 * i)
    }
    expect(sceneUpFromCameras(strip(10, tilt(0)), slope).source).toBe('cameras')
    // 30 verticals, 12 left, 16 right obliques (all of Rachel): the trim already keeps the verticals.
    const all = [...strip(30, tilt(1)), ...strip(12, tilt(60)), ...strip(16, tilt(-60))]
    const how = sceneUpFromCameras(all, pts)
    expect(how.source).toBe('cameras')
    expect(signedAngle(how.up, trueUp)).toBeLessThan(2)
    // One look 30° off nadir with no vertical group: under OBLIQUE_ONLY_DEG, kept.
    expect(mixedLookUp(strip(10, tilt(30)), mv(Q, [0, -0.5, 0.866]), pts)).toBeNull()
  })

  it('ignores a cloud that is not a plane', () => {
    let seed = 3
    const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647) * 2 - 1
    const ball = { pos: Float64Array.from({ length: 3000 }, () => 1000 * rnd()), length: 1000 }
    expect(groundUp(ball, mostlyObliques)).toBeNull()
    expect(sceneUpFromCameras(mostlyObliques, ball).source).toBe('cameras')
  })
})

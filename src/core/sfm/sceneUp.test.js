import { it, expect } from 'vitest'
import { estimateUpFromCameras, planeUpOverride } from './geometry.js'
import { sceneUpFromCameras, buildLocalFrame, aerialUpRotation } from '../products/projection.js'

// World = ENU (z up). A gimbal camera at centre C with yaw (deg clockwise from
// north) and pitch (deg, negative = down), no roll, in websfm's OpenCV convention:
// rows of R are the camera x (right), y (down) and z (forward) axes; t = −R·C.
function gimbalCam(C, yawDeg, pitchDeg) {
  const y = (yawDeg * Math.PI) / 180,
    p = (pitchDeg * Math.PI) / 180
  const z = [Math.cos(p) * Math.sin(y), Math.cos(p) * Math.cos(y), Math.sin(p)]
  const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]
  const norm = (v) => {
    const n = Math.hypot(...v)
    return v.map((c) => c / n)
  }
  const x = norm(cross(z, [0, 0, 1]))
  const yy = cross(z, x)
  const R = [x, yy, z]
  const t = R.map((row) => -(row[0] * C[0] + row[1] * C[1] + row[2] * C[2]))
  return { R, t }
}
const tiltDeg = (up) => (Math.acos(Math.min(1, up[2] / Math.hypot(...up))) * 180) / Math.PI

// St Nazaire's geometry (HANDOVER ▸ the 2026-10-09 up fix): a 50 × 45 m block at
// one altitude, every frame facing south, 75 at −26° and 51 at −50° pitch.
function stNazaire() {
  const cams = []
  for (let i = 0; i < 126; i++) {
    const C = [((i * 37) % 50) - 25, ((i * 53) % 45) - 21, 44.5 + 0.05 * Math.sin(i)]
    cams.push(gimbalCam(C, 180, i < 75 ? -25.9 : -49.7))
  }
  return cams
}

it('an oblique block at one altitude is levelled by its camera plane, not its viewing directions', () => {
  const cams = stNazaire()
  const scene = sceneUpFromCameras(cams)
  expect(scene.source).toBe('camera-plane')
  expect(tiltDeg(scene.up)).toBeLessThan(0.5)
  expect(scene.viewTiltDeg).toBeGreaterThan(30) // the old reading was this far off
  expect(tiltDeg(estimateUpFromCameras(cams))).toBeLessThan(0.5) // the 3D viewer agrees
  expect(tiltDeg(buildLocalFrame(cams, []).up)).toBeLessThan(0.5) // and the product frame
  expect(aerialUpRotation(cams)[2][2]).toBeGreaterThan(0.9999) // and the auto-orient
})

it('a nadir flight over a slope keeps the viewing direction (terrain-following)', () => {
  // Centres follow a 20° slope; the gimbal points straight down.
  const s = Math.tan((20 * Math.PI) / 180)
  const cams = []
  for (let i = 0; i < 40; i++) {
    const x = (i % 8) * 10,
      y = Math.floor(i / 8) * 10
    cams.push(gimbalCam([x, y, 60 + s * y], 0, -89.9))
  }
  expect(sceneUpFromCameras(cams).source).toBe('cameras')
  expect(tiltDeg(sceneUpFromCameras(cams).up)).toBeLessThan(0.5)
})

it('an oblique block 30° off nadir is already levelled by its plane', () => {
  const cams = Array.from({ length: 40 }, (_, i) => gimbalCam([(i % 8) * 6, Math.floor(i / 8) * 6, 50], 90, -60))
  expect(sceneUpFromCameras(cams).source).toBe('camera-plane')
  expect(tiltDeg(sceneUpFromCameras(cams).up)).toBeLessThan(0.5)
})

it('needs a 2D, thin, signable plane', () => {
  // A single strip (collinear centres) is no plane.
  const strip = Array.from({ length: 20 }, (_, i) => gimbalCam([i * 5, 0, 40], 180, -30))
  expect(planeUpOverride(strip, [0, 0, 1])).toBeNull()
  // A block with no reading to sign the normal with is refused.
  expect(planeUpOverride(stNazaire(), null, null)).toBeNull()
  // Fewer than four cameras: refused.
  expect(planeUpOverride(stNazaire().slice(0, 3), [0, 0.8, 0.6])).toBeNull()
})

it('a TMA block with unbalanced left and right obliques is levelled by its verticals', () => {
  // Rachel's mix: 30 verticals and 12 left and 16 right obliques 60° off nadir from
  // two lines whose obliques both look south-ish, all at one altitude. The plain
  // viewing-direction mean leans 20° south, under the camera-plane threshold.
  const cams = []
  for (let i = 0; i < 30; i++) cams.push(gimbalCam([(i % 3) * 4000, Math.floor(i / 3) * 1500, 5800], 0, -89.9))
  for (let i = 0; i < 12; i++) cams.push(gimbalCam([-3000, i * 2000, 5800 + 20 * Math.sin(i)], 230, -30))
  for (let i = 0; i < 16; i++) cams.push(gimbalCam([11000, i * 1500, 5800 + 20 * Math.cos(i)], 130, -30))
  const plain = cams.reduce((s, c) => s.map((v, k) => v - c.R[2][k]), [0, 0, 0])
  expect(tiltDeg(plain)).toBeGreaterThan(15) // what the mean alone gave
  expect(tiltDeg(sceneUpFromCameras(cams).up)).toBeLessThan(0.5)
  expect(tiltDeg(estimateUpFromCameras(cams))).toBeLessThan(0.5)
  expect(tiltDeg(buildLocalFrame(cams, []).up)).toBeLessThan(0.5)
})

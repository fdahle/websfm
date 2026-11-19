import { expect, it } from 'vitest'
import { gcpReadiness, controlReadiness, needWords } from './gcpReadiness.js'
import { isGroundControl } from './io/gcp.js'
import { precisionFromGcp } from './gcpAccuracy.js'

const two = [
  { imageId: 1, px: 10, py: 10 },
  { imageId: 2, px: 20, py: 20 },
]
const full = {
  name: 'G',
  role: 'control',
  x: 1,
  y: 2,
  z: 3,
  accuracyX: 0.02,
  accuracyY: 0.02,
  accuracyZ: 0.05,
  observations: two,
}

it('a control point with X, Y, Z, accuracy and two marks is ready', () => {
  expect(gcpReadiness(full)).toEqual({ role: 'control', enabled: true, ready: true, needs: [], marks: 2 })
})

it('names everything a point placed by hand still lacks, in the order it is fixed', () => {
  // Placed on the map: X/Y only, no marks.
  const placed = { name: 'G', role: 'control', x: 1, y: 2, z: null, observations: [] }
  expect(gcpReadiness(placed).needs).toEqual(['z', 'accuracy', 'marks'])
  // Added in a photo: one mark, no coordinates.
  const photo = { name: 'G', role: 'control', x: null, y: null, z: null, observations: [two[0]] }
  expect(gcpReadiness(photo)).toMatchObject({ ready: false, needs: ['xy', 'z', 'accuracy', 'marks'], marks: 1 })
  // One axis without σ is no accuracy: the fit needs all three.
  expect(gcpReadiness({ ...full, accuracyZ: null }).needs).toEqual(['accuracy'])
})

it('agrees with the rule the fit uses', () => {
  const cases = [
    full,
    { ...full, z: null },
    { ...full, accuracyX: null },
    { ...full, x: null },
    { ...full, role: 'check' },
    { ...full, role: 'marker' },
    { ...full, enabled: false },
  ]
  for (const g of cases) {
    const r = gcpReadiness(g)
    expect(r.ready && r.role === 'control', JSON.stringify(g)).toBe(
      isGroundControl(g, { precision: precisionFromGcp }) && g.observations.length >= 2,
    )
  }
})

it('a marker needs only its marks; marks in photos outside the model do not count', () => {
  expect(gcpReadiness({ role: 'marker', observations: two })).toMatchObject({ ready: true, needs: [] })
  const aligned = (id) => id === 1
  expect(gcpReadiness(full, { aligned })).toMatchObject({ ready: false, needs: ['marks'], marks: 1 })
})

it('counts the control points the georeference can use, and says why the others cannot', () => {
  const gcps = [
    full,
    { ...full, name: 'H', z: null, accuracyX: null },
    { ...full, name: 'K', role: 'check', z: null },
    { ...full, name: 'Off', enabled: false, z: null },
  ]
  expect(controlReadiness(gcps)).toEqual({
    ready: 1,
    control: 2,
    notReady: [{ name: 'H', needs: ['z', 'accuracy'], marks: 2 }],
  })
  expect(needWords(['z', 'accuracy', 'marks'], 1)).toEqual(['no Z', 'no accuracy (σ)', 'marked in 1 of 2 photos'])
})

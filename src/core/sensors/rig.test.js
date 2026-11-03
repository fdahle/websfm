import { describe, it, expect } from 'vitest'
import { findRigs, rigMembership, rigRotation, bandOffset, rigPairs, rigSummary } from './rig.js'

// Two captures of a three-band camera (Blue 0, Green 1 = reference, NIR 2), the first
// with a calibration panel, and one ordinary photo.
const bandImg = (uuid, capture, index, name, extra = {}) => ({
  uuid,
  meta: {
    make: 'MicaSense',
    model: 'RedEdge-M',
    band: { name, index, captureId: capture, rigRef: 1, wavelength: 400 + 100 * index, ...extra },
  },
})
const images = [
  bandImg('a0', 'A', 0, 'Blue', { panel: { albedo: 0.49 }, rigRelatives: [-0.42, 0.09, -0.1] }),
  bandImg('a1', 'A', 1, 'Green', { panel: { albedo: 0.49 } }),
  bandImg('a2', 'A', 2, 'NIR'),
  bandImg('b0', 'B', 0, 'Blue'),
  bandImg('b1', 'B', 1, 'Green'),
  bandImg('b2', 'B', 2, 'NIR'),
  { uuid: 'rgb', meta: { make: 'DJI', model: 'FC6310' } },
]

describe('findRigs', () => {
  it('groups band photos into captures and finds the reference band', () => {
    const [rig, more] = findRigs(images)
    expect(more).toBeUndefined()
    expect(rig.label).toBe('MicaSense RedEdge-M')
    expect(rig.bands.map((b) => [b.name, b.count, b.reference])).toEqual([
      ['Blue', 2, false],
      ['Green', 2, true],
      ['NIR', 2, false],
    ])
    expect(rig.captures.map((c) => [c.id, c.panel, c.images.length])).toEqual([
      ['A', true, 3],
      ['B', false, 3],
    ])
    expect(rigSummary(rig)).toBe(
      'MicaSense RedEdge-M: 3 bands (Blue 400 nm, Green 500 nm (reference), NIR 600 nm), 2 captures, 1 with a calibration panel',
    )
    expect(findRigs([images[6]])).toEqual([])
  })
})

describe('band offsets', () => {
  it('builds MicaSense rotations in Rx·Ry·Rz order', () => {
    const R = rigRotation([0, 0, 90])
    expect(R[0][1]).toBeCloseTo(-1, 12)
    expect(R[1][0]).toBeCloseTo(1, 12)
    const S = rigRotation([10, 20, 30])
    // Orthonormal.
    for (let i = 0; i < 3; i++)
      for (let j = 0; j < 3; j++)
        expect(S[0][i] * S[0][j] + S[1][i] * S[1][j] + S[2][i] * S[2][j]).toBeCloseTo(i === j ? 1 : 0, 12)
  })
  it('maps reference-frame points into the band frame, with the lever arm when scaled', () => {
    const ref = { rigRelatives: [0, 0, 0], rigTranslations: [0, 0, 0] }
    const band = { rigRelatives: [0, 0, 1], rigTranslations: [-50, 0, 0] }
    const { R, t } = bandOffset(band, ref, 2)
    // The band lens is turned +1° about z relative to the rig: a reference ray turns −1°.
    expect(Math.atan2(R[1][0], R[0][0]) * (180 / Math.PI)).toBeCloseTo(-1, 10)
    // Its centre is 5 cm left (−x) of the reference, 0.1 model units at 2 units per metre:
    // that centre maps to the band frame's origin.
    const c = [-0.1, 0, 0]
    const x = [0, 1, 2].map((i) => R[i][0] * c[0] + R[i][1] * c[1] + R[i][2] * c[2] + t[i])
    for (const v of x) expect(v).toBeCloseTo(0, 12)
    expect(bandOffset(band, ref).t).toEqual([0, 0, 0])
  })
})

describe('rigPairs', () => {
  it('matches reference images across captures and every band to its own reference', () => {
    const membership = rigMembership(findRigs(images))
    const byId = new Map(images.map((i) => [i.uuid, i]))
    const all = []
    for (let i = 0; i < images.length; i++) for (let j = i + 1; j < images.length; j++) all.push([images[i], images[j]])
    const { kept, added } = rigPairs(all, membership, images)
    const ids = (ps) => ps.map(([a, b]) => `${a.uuid}-${b.uuid}`)
    expect(ids(kept)).toEqual(['a1-b1'])
    expect(ids(added)).toEqual(['a1-a0', 'a1-a2', 'b1-b0', 'b1-b2'])
    // A photo outside the rig keeps its pairs with photos outside the rig only.
    const other = { uuid: 'rgb2', meta: {} }
    const panel = bandImg('p1', 'P', 1, 'Green')
    expect(
      ids(
        rigPairs(
          [
            [byId.get('rgb'), other],
            [byId.get('rgb'), byId.get('a1')],
            [panel, byId.get('rgb')],
          ],
          membership,
          images,
        ).kept,
      ),
    ).toEqual(['rgb-rgb2'])
  })
})

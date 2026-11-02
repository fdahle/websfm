import { describe, it, expect } from 'vitest'

import { footprintsEffects } from './footprintsFromPoses.js'
import { FOOTPRINT_DEFAULTS } from '../defaults.user.js'

const s = { ...FOOTPRINT_DEFAULTS }

describe('footprintsEffects', () => {
  it('says what the corners land on', () => {
    expect(footprintsEffects(s, { demName: 'Global terrain', demDatum: 'Geoid EGM96' }).ground).toBe(
      'Each corner lands where its ray meets Global terrain; the camera heights are taken to be in its datum (Geoid EGM96).',
    )
    expect(
      footprintsEffects(s, { demName: 'Lidar', demDatum: 'Geoid EGM96', poseDatum: 'Ellipsoidal' }).ground,
    ).toContain('the camera heights are Ellipsoidal, and the terrain (Geoid EGM96) is converted to it')
    expect(footprintsEffects({ ...s, ground: 'absolute', groundElev: 120 }, { unit: 'ft' }).ground).toBe(
      'Every corner lands on one level plane at 120 ft.',
    )
    expect(footprintsEffects({ ...s, ground: 'agl', agl: 80 }).ground).toContain('80 m below its camera')
  })

  it('counts the poses placed and why the others are skipped', () => {
    const breakdown = { ok: 40, noPose: 0, noElevation: 0, noAngles: 3, noSensor: 2, belowPlane: 0 }
    const e = footprintsEffects(s, { breakdown, total: 45 })
    expect(e.cameras).toBe(
      '40 of 45 poses get a footprint; skipped: 3 with no orientation angles (Assume nadir is off), ' +
        '2 with no calibrated sensor or intrinsics. Fill in the manual intrinsics to place those without a sensor.',
    )
    expect(footprintsEffects(s, { breakdown, total: 45, fallback: true }).cameras).not.toContain('Fill in')
    expect(footprintsEffects(s, { breakdown: { ok: 1 }, total: 1 }).cameras).toBe('1 of 1 pose gets a footprint.')
    expect(footprintsEffects(s, {}).cameras).toContain('no camera poses')
  })
})

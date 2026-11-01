import { describe, expect, it } from 'vitest'
import { COREG_DEFAULTS } from '../defaults.user.js'
import { coregisterEffects, describeCoregistration } from './coregister.js'

const project = {
  demName: 'DEM',
  demInCrs: true,
  demCrs: 'EPSG:3031',
  referenceName: 'rema_4m',
  stableName: 'rock',
  georefCrs: 'EPSG:3031',
}

describe('coregisterEffects', () => {
  it('describes the default chain on a copy of the DEM', () => {
    const e = coregisterEffects(COREG_DEFAULTS, project)
    expect(e.stable).toBe(
      'Only the cells of "DEM" inside "rock" are compared with "rema_4m": ground that changed stays out of the fit.',
    )
    expect(e.horizontal).toMatch(/^Shifts the DEM east and north .*Nuth & Kääb.*5–45°\.$/)
    expect(e.vertical).toBe('Removes the median height difference left after the shift.')
    expect(e.tilt).toBe('Off: no tilt is removed.')
    expect(e.apply).toMatch(/^A new DEM "DEM \(co-registered\)" is added beside "DEM"/)
    expect(e.blocked).toBeNull()
    expect(e.current).toBeNull()
  })

  it('warns without stable ground, and says what the tilt takes up', () => {
    const e = coregisterEffects({ ...COREG_DEFAULTS, vertical: false, tilt: 'plane' }, { ...project, stableName: null })
    expect(e.stable).toMatch(/^Every cell of "DEM" is compared .* choose a layer of stable ground\.$/)
    expect(e.vertical).toMatch(/constant term/)
    expect(e.tilt).toMatch(/^Fits a plane/)
  })

  it('moves the georeference, with a plane but not a quadratic', () => {
    const g = { ...COREG_DEFAULTS, applyTo: 'georeference' }
    expect(coregisterEffects({ ...g, tilt: 'plane' }, project).blocked).toBeNull()
    expect(coregisterEffects(g, project).apply).toMatch(/^The georeference moves onto "rema_4m": .*rebuild them\./)
    const q = coregisterEffects({ ...g, tilt: 'quadratic' }, project)
    expect(q.tilt).toMatch(/cannot move the georeference/)
    expect(q.blocked).toBe('A quadratic tilt applies to the DEM only.')
    expect(coregisterEffects(g, { ...project, georefCrs: null }).blocked).toMatch(/no georeference/)
    expect(coregisterEffects(g, { ...project, demCrs: 'EPSG:32633' }).blocked).toMatch(
      /build the DEM in the project CRS/,
    )
  })

  it('says why it cannot run', () => {
    expect(coregisterEffects(COREG_DEFAULTS, { ...project, demInCrs: false }).blocked).toMatch(/local frame/)
    expect(coregisterEffects(COREG_DEFAULTS, { ...project, referenceName: null }).blocked).toMatch(/Import a reference/)
    expect(coregisterEffects(COREG_DEFAULTS, { ...project, demTiled: true }).blocked).toMatch(/kept as tiles/)
    const none = { ...COREG_DEFAULTS, horizontal: false, vertical: false }
    expect(coregisterEffects(none, project).blocked).toBe('Turn on at least one step.')
  })

  it('names a co-registration the georeference carries', () => {
    const current = { reference: 'rema_4m', move: [-1.1, -7.9, 0.8], tilt: false }
    expect(describeCoregistration(current)).toBe('"rema_4m" (moved E −1.1, N −7.9, Z +0.8 m)')
    expect(coregisterEffects(COREG_DEFAULTS, { ...project, current }).current).toBe(
      'The georeference is co-registered to "rema_4m" (moved E −1.1, N −7.9, Z +0.8 m).',
    )
    const g = { ...COREG_DEFAULTS, applyTo: 'georeference' }
    expect(coregisterEffects(g, { ...project, current, chain: true }).apply).toMatch(/on top of the current move/)
    expect(coregisterEffects(g, { ...project, current }).apply).toMatch(/in place of the current move/)
  })
})

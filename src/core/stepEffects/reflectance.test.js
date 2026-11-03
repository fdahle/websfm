import { describe, it, expect } from 'vitest'
import { reflectanceEffects } from './reflectance.js'
import { REFLECTANCE_DEFAULTS } from '../defaults.user.js'

const rig = { label: 'MicaSense Altum-PT', bands: 7, captures: 556, panelCaptures: 2, dls: true, thermal: true }
const dem = { width: 1000, height: 800, gsd: 0.1, unit: 'm' }

describe('reflectance map effects', () => {
  it('says how radiance becomes reflectance here', () => {
    expect(reflectanceEffects(REFLECTANCE_DEFAULTS, { rig, dem }).calibration).toBe(
      "2 panel captures: reflectance from the panel's known albedo, carried through the flight by the sun " +
        "sensor's reading at each photo. The thermal band is in °C.",
    )
    expect(
      reflectanceEffects(REFLECTANCE_DEFAULTS, { rig: { ...rig, panelCaptures: 0, thermal: false }, dem }).calibration,
    ).toBe("Auto: reflectance from the sun sensor's reading at each photo.")
    expect(
      reflectanceEffects({ ...REFLECTANCE_DEFAULTS, calibration: 'panel' }, { rig: { ...rig, panelCaptures: 0 } })
        .calibration,
    ).toMatch(/^No capture shows the calibration panel/)
    expect(reflectanceEffects({ ...REFLECTANCE_DEFAULTS, calibration: 'radiance' }, { rig, dem }).calibration).toMatch(
      /radiance \(W/,
    )
    expect(reflectanceEffects(REFLECTANCE_DEFAULTS, {}).calibration).toMatch(/^No multispectral photos/)
  })
  it('says how large the map gets', () => {
    expect(reflectanceEffects(REFLECTANCE_DEFAULTS, { rig, dem }).grid).toMatch(
      /^Auto: the reference band's own ground pixel/,
    )
    expect(reflectanceEffects({ ...REFLECTANCE_DEFAULTS, gsd: 0.05 }, { rig, dem }).grid).toBe(
      '2,000 × 1,600 cells at 0.05 m, 7 bands: about 85 MB before compression.',
    )
    expect(reflectanceEffects(REFLECTANCE_DEFAULTS, { rig }).grid).toMatch(/^Build a DEM first/)
  })
})

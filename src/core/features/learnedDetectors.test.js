import { it, expect, describe } from 'vitest'
import {
  LEARNED_DETECTORS, DETECTOR_IDS, learnedDetector, isLearnedDetector, detectorLabel, lightGlueModelFor,
} from './learnedDetectors.js'
import { MODELS } from '../models/registry.js'
import { DETECT_DEFAULTS_BY_DETECTOR, DETECT_PRESETS_BY_DETECTOR } from '../defaults.user.js'
import { DETECT_RESOLUTION_BANDS } from './detectResolution.js'

describe('learned detector registry', () => {
  it('every detector names downloadable weights, a LightGlue, defaults, presets and bands', () => {
    for (const spec of Object.values(LEARNED_DETECTORS)) {
      expect(MODELS[spec.modelId]).toBeTruthy()
      expect(MODELS[spec.matcherModelId]).toBeTruthy()
      expect([1, 3]).toContain(spec.channels)
    }
    for (const id of DETECTOR_IDS) {
      expect(DETECT_DEFAULTS_BY_DETECTOR[id]).toBeTruthy()
      expect(DETECT_PRESETS_BY_DETECTOR[id]).toBeTruthy()
      expect(DETECT_RESOLUTION_BANDS[id]).toBeTruthy()
    }
  })

  it('treats SIFT and unknown ids as not learned', () => {
    expect(isLearnedDetector('sift')).toBe(false)
    expect(isLearnedDetector(undefined)).toBe(false)
    expect(learnedDetector('orb')).toBeNull()
    expect(detectorLabel('disk')).toBe('DISK')
    expect(detectorLabel(undefined)).toBe('SIFT')
  })
})

describe('lightGlueModelFor', () => {
  const im = (name, detector, descDim) => ({ name, detector, descDim })

  it('picks the LightGlue trained for the images\' detector', () => {
    expect(lightGlueModelFor([im('a', 'superpoint', 256), im('b', 'superpoint', 256)]))
      .toMatchObject({ ok: true, modelId: 'lightglue' })
    expect(lightGlueModelFor([im('a', 'disk', 128), im('b', 'disk', 128)]))
      .toMatchObject({ ok: true, modelId: 'lightglue_disk' })
  })

  it('refuses SIFT, and names the odd ones out of a mix', () => {
    expect(lightGlueModelFor([im('a', 'sift', 128), im('b', undefined, 128)]).ok).toBe(false)
    const mixed = lightGlueModelFor([im('a', 'disk', 128), im('b', 'disk', 128), im('c', 'superpoint', 256)])
    expect(mixed.ok).toBe(false)
    expect(mixed.bad.map((x) => x.name)).toEqual(['c'])
  })

  it('refuses a learned detector at the wrong descriptor width', () => {
    const r = lightGlueModelFor([im('a', 'disk', 128), im('b', 'disk', 256)])
    expect(r.ok).toBe(false)
    expect(r.bad.map((x) => x.name)).toEqual(['b'])
  })
})

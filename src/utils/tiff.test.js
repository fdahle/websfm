import { describe, it, expect } from 'vitest'
import { isAxisAlignedModelTransformation, isDegenerateGeoTransform } from './tiff.js'

// The predicate that decides whether a TIFF's geolocation tags mean anything.
// It sits on the fork between "reference raster" and "source photo", so a wrong
// answer sends a whole flight strip into the wrong half of the app.
describe('isDegenerateGeoTransform', () => {
  const scan = { pixelScale: [1, 1, 0], tiepoint: [0, 0, 0, 0, 0, 0], hasCrs: false }

  it('flags the scanner placeholder: unit scale at the origin with no CRS', () => {
    // The aerial film scans (CA213732V00xx.tif) that were misrouted as orthophotos.
    expect(isDegenerateGeoTransform(scan)).toBe(true)
  })

  it('flags a negative unit scale (north-up sign convention, still the identity)', () => {
    expect(isDegenerateGeoTransform({ ...scan, pixelScale: [1, -1, 0] })).toBe(true)
  })

  it('flags the TMA scanner placeholder written as a ModelTransformation', () => {
    // Header from CA213732V0032.tif: pixel coordinates at 0/0, no CRS.
    expect(isDegenerateGeoTransform({
      transformation: [
        1, 0, 0, 0,
        0, 1, 0, 0,
        0, 0, 0, 0,
        0, 0, 0, 1,
      ],
      hasCrs: false,
    })).toBe(true)
  })

  it('keeps a ModelTransformation with a real-world origin', () => {
    expect(isDegenerateGeoTransform({
      transformation: [
        1, 0, 0, 500000,
        0, -1, 0, 4000000,
        0, 0, 1, 0,
        0, 0, 0, 1,
      ],
      hasCrs: false,
    })).toBe(false)
  })

  it('flags absent or zero scale', () => {
    expect(isDegenerateGeoTransform({ ...scan, pixelScale: [0, 0, 0] })).toBe(true)
    expect(isDegenerateGeoTransform({ ...scan, pixelScale: undefined })).toBe(true)
  })

  it('a declared CRS makes it real, whatever the numbers look like', () => {
    // The CRS is what gives an origin of 0,0 a meaning, so it overrides.
    expect(isDegenerateGeoTransform({ ...scan, hasCrs: true })).toBe(false)
  })

  it('a real ground sample distance is georeferencing even without a CRS', () => {
    // The benchmark Sentinel-2 scene's shape: 10 m pixels, real origin.
    expect(isDegenerateGeoTransform({
      pixelScale: [10, 10, 0],
      tiepoint: [0, 0, 0, -2500000, 1300000, 0],
      hasCrs: false,
    })).toBe(false)
  })

  it('a non-zero origin at unit scale is kept — 1 m pixels are legitimate', () => {
    expect(isDegenerateGeoTransform({
      pixelScale: [1, 1, 0],
      tiepoint: [0, 0, 0, 500000, 4000000, 0],
      hasCrs: false,
    })).toBe(false)
  })
})

describe('isAxisAlignedModelTransformation', () => {
  const axisAligned = [
    10, 0, 0, 500000,
    0, -10, 0, 4000000,
    0, 0, 1, 0,
    0, 0, 0, 1,
  ]

  it('accepts a finite axis-aligned affine matrix', () => {
    expect(isAxisAlignedModelTransformation(axisAligned)).toBe(true)
  })

  it('rejects rotation, shear, perspective and malformed matrices', () => {
    const rotated = [...axisAligned]
    rotated[1] = 0.25
    const sheared = [...axisAligned]
    sheared[4] = -0.25
    const perspective = [...axisAligned]
    perspective[12] = 1e-3
    expect(isAxisAlignedModelTransformation(rotated)).toBe(false)
    expect(isAxisAlignedModelTransformation(sheared)).toBe(false)
    expect(isAxisAlignedModelTransformation(perspective)).toBe(false)
    expect(isAxisAlignedModelTransformation([1, 0, 0])).toBe(false)
  })
})

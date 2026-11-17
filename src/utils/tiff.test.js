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
    expect(
      isDegenerateGeoTransform({
        transformation: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
        hasCrs: false,
      }),
    ).toBe(true)
  })

  it('keeps a ModelTransformation with a real-world origin', () => {
    expect(
      isDegenerateGeoTransform({
        transformation: [1, 0, 0, 500000, 0, -1, 0, 4000000, 0, 0, 1, 0, 0, 0, 0, 1],
        hasCrs: false,
      }),
    ).toBe(false)
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
    expect(
      isDegenerateGeoTransform({
        pixelScale: [10, 10, 0],
        tiepoint: [0, 0, 0, -2500000, 1300000, 0],
        hasCrs: false,
      }),
    ).toBe(false)
  })

  it('a non-zero origin at unit scale is kept — 1 m pixels are legitimate', () => {
    expect(
      isDegenerateGeoTransform({
        pixelScale: [1, 1, 0],
        tiepoint: [0, 0, 0, 500000, 4000000, 0],
        hasCrs: false,
      }),
    ).toBe(false)
  })

  // The pixel grid flipped to y-up: pixel 0,0 at world (0, height), so the image
  // fills 0…width × 0…height. Header of the TMA CA213732V0068.tif scan
  // (10136 × 9872), which went to Reference Data as an orthophoto.
  const flipped = { pixelScale: [1, 1, 0], tiepoint: [0, 0, 0, 0, 9872, 0], hasCrs: false }

  it('flags the pixel grid flipped to y-up (bottom-left corner at the origin)', () => {
    expect(isDegenerateGeoTransform({ ...flipped, width: 10136, height: 9872 })).toBe(true)
  })

  it('flags the flipped grid written as a ModelTransformation', () => {
    const transformation = [1, 0, 0, 0, 0, -1, 0, 9872, 0, 0, 1, 0, 0, 0, 0, 1]
    expect(isDegenerateGeoTransform({ transformation, hasCrs: false, width: 10136, height: 9872 })).toBe(true)
  })

  it('flags a grid with any corner at the origin, and a half-pixel shift', () => {
    const size = { width: 400, height: 300, hasCrs: false }
    // Top-right corner at 0,0: x runs negative.
    expect(isDegenerateGeoTransform({ ...size, pixelScale: [1, 1, 0], tiepoint: [0, 0, 0, -400, 0, 0] })).toBe(true)
    // Pixel centres pinned: the bottom-left corner half a pixel off the origin.
    expect(isDegenerateGeoTransform({ ...size, pixelScale: [1, 1, 0], tiepoint: [0, 0, 0, -0.5, 300.5, 0] })).toBe(true)
  })

  it('without the image size only the top-left corner can be tested', () => {
    expect(isDegenerateGeoTransform(flipped)).toBe(false)
  })

  it('keeps a raster whose corner is near the origin but not on it, or not at unit scale', () => {
    const size = { width: 10136, height: 9872, hasCrs: false }
    // 1 m pixels, a local frame starting 2 m off the origin.
    expect(isDegenerateGeoTransform({ ...size, pixelScale: [1, 1, 0], tiepoint: [0, 0, 0, 0, 9874, 0] })).toBe(false)
    // The same layout at 0.5 m pixels: a real ground sample distance.
    expect(isDegenerateGeoTransform({ ...size, pixelScale: [0.5, 0.5, 0], tiepoint: [0, 0, 0, 0, 4936, 0] })).toBe(
      false,
    )
    // A CRS still makes it real.
    expect(isDegenerateGeoTransform({ ...flipped, ...size, hasCrs: true })).toBe(false)
  })

  it('keeps a rotated or perspective ModelTransformation', () => {
    const size = { width: 400, height: 300, hasCrs: false }
    expect(
      isDegenerateGeoTransform({ ...size, transformation: [1, 0.2, 0, 0, 0, -1, 0, 300, 0, 0, 1, 0, 0, 0, 0, 1] }),
    ).toBe(false)
    expect(
      isDegenerateGeoTransform({ ...size, transformation: [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 1e-3, 0, 0, 1] }),
    ).toBe(false)
  })
})

describe('isAxisAlignedModelTransformation', () => {
  const axisAligned = [10, 0, 0, 500000, 0, -10, 0, 4000000, 0, 0, 1, 0, 0, 0, 0, 1]

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

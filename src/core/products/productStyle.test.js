import { describe, it, expect } from 'vitest'
import {
  resolveDemStyle,
  demRenderOptions,
  resolveOrthoStyle,
  isDefaultOrthoStyle,
  orthoGpuAdjustments,
  adjustChannel,
  orthoFilterSteps,
  demThumbnailGrid,
} from './productStyle.js'
import { hillshadeRgba } from './colormap.js'
import { gpuRasterStyle } from '../io/rasterGpuStyle.js'

const dem = {
  width: 4,
  height: 2,
  gsd: 1,
  zMin: 10,
  zMax: 20,
  data: new Float32Array([10, 12, 14, 16, 18, 20, NaN, 15]),
  mask: new Uint8Array([1, 1, 1, 1, 1, 1, 0, 1]),
}

describe('DEM symbology', () => {
  it('defaults to the unstyled preview and drops invalid fields', () => {
    expect(resolveDemStyle(null)).toEqual({ ramp: 'turbo', range: 'auto', min: null, max: null, hillshade: true })
    expect(resolveDemStyle({ ramp: 'nope', range: 'manual', min: 5, max: 5, hillshade: 0 })).toEqual({
      ramp: 'turbo',
      range: 'auto',
      min: null,
      max: null,
      hillshade: true,
    })
    expect(resolveDemStyle({ ramp: 'gray', range: 'manual', min: '0', max: 100, hillshade: false })).toEqual({
      ramp: 'gray',
      range: 'manual',
      min: 0,
      max: 100,
      hillshade: false,
    })
  })

  it('spans the DEM range automatically and the user limits when manual', () => {
    expect(demRenderOptions(null, dem)).toEqual({ ramp: 'turbo', min: 10, max: 20, hillshade: true })
    expect(demRenderOptions({ range: 'manual', min: 0, max: 50, ramp: 'viridis' }, dem)).toEqual({
      ramp: 'viridis',
      min: 0,
      max: 50,
      hillshade: true,
    })
  })

  it('renders the unstyled preview exactly as before, and a styled one differently', () => {
    const before = hillshadeRgba(dem)
    expect(hillshadeRgba(dem, demRenderOptions(null, dem))).toEqual(before)
    const grey = hillshadeRgba(dem, demRenderOptions({ ramp: 'gray', hillshade: false }, dem))
    expect([...grey.slice(0, 4)]).toEqual([0, 0, 0, 255]) // the lowest cell, unshaded
    expect([...grey.slice(20, 24)]).toEqual([255, 255, 255, 255]) // the highest
    expect(grey[6 * 4 + 3]).toBe(0) // nodata stays transparent
  })

  it('samples a thumbnail grid with a matching GSD', () => {
    const big = {
      ...dem,
      width: 1000,
      height: 500,
      data: new Float32Array(500000).fill(12),
      mask: new Uint8Array(500000).fill(1),
    }
    const t = demThumbnailGrid(big, 100)
    expect([t.width, t.height]).toEqual([100, 50])
    expect(t.gsd).toBeCloseTo(10)
    expect(t.data.every((v) => v === 12)).toBe(true)
  })
})

describe('orthophoto symbology', () => {
  it('clamps values and recognises the neutral style', () => {
    expect(resolveOrthoStyle({ brightness: 3, contrast: -2, gamma: 0 })).toEqual({
      brightness: 1,
      contrast: -1,
      gamma: 1,
    })
    expect(isDefaultOrthoStyle(undefined)).toBe(true)
    expect(isDefaultOrthoStyle({ gamma: 1.2 })).toBe(false)
  })

  it('adds only non-neutral adjustments to the GPU style', () => {
    const meta = { bands: 4, kind: 'ortho', photometric: 2, alphaBand: 3 }
    expect(Object.keys(gpuRasterStyle(meta))).toEqual(['color'])
    expect(orthoGpuAdjustments({ contrast: 0.2 })).toEqual({ contrast: 0.2 })
    expect(gpuRasterStyle({ ...meta, adjust: { brightness: 0.1, gamma: 2 } })).toMatchObject({
      brightness: 0.1,
      gamma: 2,
    })
  })

  it('maps channels like the WebGLTile shader: contrast, then gamma, then brightness', () => {
    expect(adjustChannel(128, null)).toBe(128)
    expect(adjustChannel(255, { contrast: 0.5 })).toBe(255)
    expect(adjustChannel(64, { contrast: 1 })).toBe(0)
    expect(adjustChannel(64, { gamma: 2 })).toBe(Math.round(Math.sqrt(64 / 255) * 255))
    expect(adjustChannel(200, { brightness: 0.5 })).toBe(255)
  })

  it('builds the matching SVG transfer chain', () => {
    expect(orthoFilterSteps(null)).toEqual([])
    expect(orthoFilterSteps({ contrast: 0.5, gamma: 2, brightness: -0.1 })).toEqual([
      { type: 'linear', slope: 1.5, intercept: -0.25 },
      { type: 'gamma', amplitude: 1, exponent: 0.5, offset: 0 },
      { type: 'linear', slope: 1, intercept: -0.1 },
    ])
  })
})

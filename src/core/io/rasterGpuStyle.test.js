import { describe, it, expect } from 'vitest'
import { parse, ColorType, newParsingContext } from 'ol/expr/expression.js'
import { gpuRasterStyle, safeStretchRange } from './rasterGpuStyle.js'

it.each([
  { bands:1, bitsPerSample:16, style:{mode:'gray',ranges:[[1000,3000]]} },
  { bands:1, kind:'dem', zMin:0, zMax:100, rawNodata:-9999 },
  { bands:6, style:{mode:'rgb',bandR:3,bandG:4,bandB:5,ranges:[[0,3000],[0,3000],[0,3000]]} },
  { bands:6, style:{mode:'index',bandA:4,bandB2:2} },
  { bands:4, kind:'ortho', photometric:2, alphaBand:3 },
])('produces a valid OpenLayers color expression for %j', meta => {
  expect(() => parse(gpuRasterStyle(meta).color, ColorType, newParsingContext())).not.toThrow()
})

it('a computed orthophoto reads its alpha band: transparent cells are nodata, partial ones blend', () => {
  const json = JSON.stringify(gpuRasterStyle({ bands: 4, kind: 'ortho', photometric: 2, alphaBand: 3 }))
  expect(json).toContain(JSON.stringify(['>', ['band', 4], 0]))
  expect(json).toContain(JSON.stringify(['/', ['band', 4], 255]))
  expect(JSON.stringify(gpuRasterStyle({ bands: 4, kind: 'ortho' }))).not.toContain('["band",4]')
})

describe('safeStretchRange', () => {
  it('never yields a NaN or zero-width stretch', () => {
    expect(safeStretchRange([2, 5])).toEqual([2, 5])
    expect(safeStretchRange([3, 3])).toEqual([3, 4])
    expect(safeStretchRange([3, null])).toEqual([3, 4])
    expect(safeStretchRange([undefined, 9])).toEqual([8, 9])
    expect(safeStretchRange(null)).toEqual([0, 255])
  })

  it('a DEM with no recorded zMax compiles a finite expression', () => {
    const json = JSON.stringify(gpuRasterStyle({ kind: 'dem', zMin: 12, zMax: null, bands: 1, bitsPerSample: 32, sampleFormat: 3 }))
    expect(json).not.toMatch(/null|NaN/)
  })
})

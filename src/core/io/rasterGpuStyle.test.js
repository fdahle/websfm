import { it, expect } from 'vitest'
import { parse, ColorType, newParsingContext } from 'ol/expr/expression.js'
import { gpuRasterStyle } from './rasterGpuStyle.js'

it.each([
  { bands:1, bitsPerSample:16, style:{mode:'gray',ranges:[[1000,3000]]} },
  { bands:1, kind:'dem', zMin:0, zMax:100, rawNodata:-9999 },
  { bands:6, style:{mode:'rgb',bandR:3,bandG:4,bandB:5,ranges:[[0,3000],[0,3000],[0,3000]]} },
  { bands:6, style:{mode:'index',bandA:4,bandB2:2} },
])('produces a valid OpenLayers color expression for %j', meta => {
  expect(() => parse(gpuRasterStyle(meta).color, ColorType, newParsingContext())).not.toThrow()
})

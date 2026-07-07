import { describe, it, expect } from 'vitest'
import { cloudToPly, reconstructionToJson, demToAsciiGrid, rasterWorldFile } from './exporters.js'

describe('cloudToPly', () => {
  const points = [
    { x: 1.5, y: -2.25, z: 3.0, color: [255, 0, 128] },
    { x: 0, y: 0, z: 0 }, // no colour → default grey
  ]

  it('writes a valid binary PLY header with the right vertex count', () => {
    const bytes = cloudToPly(points)
    const text = new TextDecoder().decode(bytes.subarray(0, 256))
    expect(text.startsWith('ply\n')).toBe(true)
    expect(text).toContain('format binary_little_endian 1.0')
    expect(text).toContain('element vertex 2')
    expect(text).toContain('end_header\n')
  })

  it('packs xyz as little-endian float32 + rgb as uint8', () => {
    const bytes = cloudToPly(points)
    const headerLen = bytes.length - points.length * 15
    const dv = new DataView(bytes.buffer, headerLen)
    expect(dv.getFloat32(0, true)).toBeCloseTo(1.5, 5)
    expect(dv.getFloat32(4, true)).toBeCloseTo(-2.25, 5)
    expect(dv.getFloat32(8, true)).toBeCloseTo(3.0, 5)
    expect(dv.getUint8(12)).toBe(255)
    expect(dv.getUint8(13)).toBe(0)
    expect(dv.getUint8(14)).toBe(128)
    // Second vertex: default grey.
    expect(dv.getUint8(15 + 12)).toBe(200)
  })

  it('writes ASCII PLY, and honours color:false (no rgb properties)', () => {
    const ascii = cloudToPly(points, { binary: false })
    expect(typeof ascii).toBe('string')
    expect(ascii).toContain('format ascii 1.0')
    expect(ascii).toContain('1.5 -2.25 3 255 0 128')

    const noColor = cloudToPly(points, { binary: false, color: false })
    expect(noColor).not.toContain('property uchar red')
    expect(noColor).toContain('1.5 -2.25 3\n')
  })
})

describe('reconstructionToJson', () => {
  it('emits cameras with centres (C = −Rᵀt) + tracks + crs', () => {
    const cameras = [{ uuid: 'a', R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [1, 2, 3], K: { fx: 100, fy: 100, cx: 50, cy: 40, extra: 9 } }]
    const points = [{ x: 1, y: 2, z: 3, color: [10, 20, 30], views: [['a', 5]] }]
    const j = reconstructionToJson(cameras, points, 'EPSG:3031')
    expect(j.crs).toBe('EPSG:3031')
    expect(j.cameras[0].center).toEqual([-1, -2, -3]) // identity R ⇒ C = −t
    expect(j.cameras[0].K).toEqual({ fx: 100, fy: 100, cx: 50, cy: 40 }) // trimmed
    expect(j.points[0].views).toEqual([['a', 5]])
  })
})

describe('demToAsciiGrid', () => {
  const dem = {
    width: 2, height: 2, gsd: 10, originX: 100, originY: 200,
    data: Float32Array.from([1, 2, NaN, 4]), // row-major, top→bottom; NaN = hole
  }

  it('writes the ESRI header with a lower-left corner derived from the top origin', () => {
    const asc = demToAsciiGrid(dem)
    expect(asc).toContain('ncols 2\n')
    expect(asc).toContain('nrows 2\n')
    expect(asc).toContain('xllcorner 100\n')
    expect(asc).toContain('yllcorner 180\n') // originY − height·gsd = 200 − 20
    expect(asc).toContain('cellsize 10\n')
    expect(asc).toContain('NODATA_value -9999\n')
  })

  it('emits rows top→bottom and maps NaN to NODATA', () => {
    const body = demToAsciiGrid(dem).trim().split('\n').slice(6)
    expect(body).toEqual(['1 2', '-9999 4'])
  })
})

describe('rasterWorldFile', () => {
  it('emits 6 lines with pixel size + upper-left pixel centre', () => {
    const wld = rasterWorldFile({ gsd: 10, originX: 100, originY: 200 }).trim().split('\n').map(Number)
    expect(wld).toEqual([10, 0, 0, -10, 105, 195]) // centre = corner ± gsd/2
  })
})

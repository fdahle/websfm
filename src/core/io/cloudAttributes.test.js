import { it, expect } from 'vitest'
import { decodeLasPoints } from './las.js'
import { parsePly } from './ply.js'
import { parseXyzText } from './cloudText.js'
import { applyImportTransform } from './cloudImport.js'

it('decodes legacy LAS flags independently of classification, with signed scan angles and GPS precision', () => {
  const bytes = new Uint8Array(34)
  const dv = new DataView(bytes.buffer)
  dv.setUint16(12, 45678, true)
  bytes[14] = 2 | (3 << 3) | 0xc0
  bytes[15] = 6 | 0xa0
  dv.setInt8(16, -17); bytes[17] = 43
  dv.setUint16(18, 1024, true); dv.setFloat64(20, 123456789.123, true)
  const { attributes: a } = decodeLasPoints(bytes, 1, 34, 3, [1, 1, 1], [0, 0, 0])
  expect(a.classification[0]).toBe(6)
  expect(a.intensity[0]).toBe(45678)
  expect([a.returnNumber[0], a.numberOfReturns[0], a.scanAngle[0], a.userData[0], a.pointSourceId[0]]).toEqual([2, 3, -17, 43, 1024])
  expect([a.synthetic[0], a.keyPoint[0], a.withheld[0], a.scanDirection[0], a.edgeOfFlightLine[0]]).toEqual([1, 0, 1, 1, 1])
  expect(a.gpsTime[0]).toBe(123456789.123)
  expect(a.overlap).toBeUndefined()
})

it('decodes LAS 1.4 full-byte class ids, scanner channel, overlap, scan angle and NIR', () => {
  const bytes = new Uint8Array(38), dv = new DataView(bytes.buffer)
  bytes[14] = 9 | (12 << 4); bytes[15] = 0xef; bytes[16] = 200; bytes[17] = 91
  dv.setInt16(18, -1234, true); dv.setUint16(20, 7654, true)
  dv.setFloat64(22, 987654321.125, true); dv.setUint16(36, 60000, true)
  const { attributes: a } = decodeLasPoints(bytes, 1, 38, 8, [1, 1, 1], [0, 0, 0])
  expect([a.classification[0], a.returnNumber[0], a.numberOfReturns[0], a.scannerChannel[0], a.overlap[0]]).toEqual([200, 9, 12, 2, 1])
  expect(a.scanAngle[0]).toBeCloseTo(-7.404, 5)
  expect([a.userData[0], a.pointSourceId[0], a.nir[0], a.gpsTime[0]]).toEqual([91, 7654, 60000, 987654321.125])
})

it('retains arbitrary ASCII/binary PLY scalar fields and text intensity', () => {
  const header = format => `ply\nformat ${format} 1.0\nelement vertex 1\nproperty float x\nproperty float y\nproperty float z\nproperty ushort intensity\nproperty uchar classification\nend_header\n`
  const ascii = parsePly(header('ascii') + '1 2 3 65500 6\n')
  expect([...ascii.attributes.intensity]).toEqual([65500])
  const prefix = new TextEncoder().encode(header('binary_little_endian'))
  const bytes = new Uint8Array(prefix.length + 15); bytes.set(prefix)
  const dv = new DataView(bytes.buffer, prefix.length)
  dv.setFloat32(0, 1, true); dv.setFloat32(4, 2, true); dv.setFloat32(8, 3, true)
  dv.setUint16(12, 65500, true); dv.setUint8(14, 6)
  expect(parsePly(bytes).attributes).toEqual(ascii.attributes)
  expect([...parseXyzText('1 2 3 99 255 0 0\n').attributes.intensity]).toEqual([99])
  expect(parseXyzText('1 2 3 255 0 0\n').attributes).toBeUndefined()
  const transformed = applyImportTransform(ascii, { unitScale: 2, subsampleCell: 10 })
  expect([...transformed.attributes.classification]).toEqual([6])
  expect([...transformed.pos]).toEqual([2, 4, 6])
})

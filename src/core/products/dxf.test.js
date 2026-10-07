import { describe, it, expect } from 'vitest'
import { writeDxf, formatDxfNumber, dxfLayerName } from './dxf.js'

// DXF text → [[code, value], …]
function parseDxfPairs(text) {
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  const pairs = []
  for (let i = 0; i + 1 < lines.length; i += 2) pairs.push([Number(lines[i].trim()), lines[i + 1]])
  return pairs
}
const count = (pairs, name) => pairs.filter(([c, v]) => c === 0 && v === name).length

describe('formatDxfNumber', () => {
  it('prints survey-scale values fixed-point, never with an exponent', () => {
    expect(formatDxfNumber(1234567.891234)).toBe('1234567.891234')
    expect(formatDxfNumber(-6543210.5)).toBe('-6543210.5')
    expect(formatDxfNumber(1e-9)).toBe('0.0')
    expect(formatDxfNumber(12)).toBe('12.0')
    expect(formatDxfNumber(-0)).toBe('0.0')
    expect(formatDxfNumber(2.5e7)).not.toMatch(/e/i)
  })
  it('rejects non-finite values', () => {
    expect(() => formatDxfNumber(NaN)).toThrow(/non-finite/)
  })
})

describe('dxfLayerName', () => {
  it('upper-cases and replaces characters R12 does not allow', () => {
    expect(dxfLayerName('contour lines')).toBe('CONTOUR_LINES')
    expect(dxfLayerName('a'.repeat(40))).toHaveLength(31)
    expect(dxfLayerName('')).toBe('0')
  })
})

describe('writeDxf', () => {
  const doc = {
    layers: [{ name: 'CONTOUR', color: 8 }, { name: 'CONTOUR_INDEX', color: 7 }],
    polylines: [
      { layer: 'CONTOUR', points: [[500000.123456, 4200000.5], [500010, 4200010]], elevation: 120 },
      { layer: 'CONTOUR_INDEX', points: [[0, 0], [1, 0], [1, 1]], closed: true, elevation: 125 },
      { layer: 'BREAK', points: [[0, 0, 1], [1, 0, 2], [2, 0, 3]] },
    ],
    points: [{ layer: 'CONTOUR', x: 1, y: 2, z: 3 }],
  }
  const text = writeDxf(doc)
  const pairs = parseDxfPairs(text)

  it('has HEADER, TABLES, ENTITIES and EOF with R12 version', () => {
    const sections = pairs.filter(([c], i) => c === 2 && pairs[i - 1]?.[1] === 'SECTION').map(([, v]) => v)
    expect(sections).toEqual(['HEADER', 'TABLES', 'ENTITIES'])
    expect(count(pairs, 'ENDSEC')).toBe(3)
    expect(pairs[pairs.length - 1]).toEqual([0, 'EOF'])
    const ver = pairs.findIndex(([c, v]) => c === 9 && v === '$ACADVER')
    expect(pairs[ver + 1]).toEqual([1, 'AC1009'])
  })

  it('declares every layer, including undeclared referenced ones', () => {
    const names = pairs.filter(([c], i) => c === 2 && pairs[i - 1]?.[1] === 'LAYER' && pairs[i - 1][0] === 0).map(([, v]) => v)
    expect(names).toEqual(['0', 'CONTOUR', 'CONTOUR_INDEX', 'BREAK'])
    const tbl = pairs.findIndex(([c, v], i) => c === 2 && v === 'LAYER' && pairs[i - 1][1] === 'TABLE')
    expect(pairs[tbl + 1]).toEqual([70, '4'])
  })

  it('writes one POLYLINE/SEQEND per line and one VERTEX per point', () => {
    expect(count(pairs, 'POLYLINE')).toBe(3)
    expect(count(pairs, 'SEQEND')).toBe(3)
    expect(count(pairs, 'VERTEX')).toBe(2 + 3 + 3)
    expect(count(pairs, 'POINT')).toBe(1)
  })

  it('sets the closed flag, 2D elevation and 3D flag', () => {
    const flags = []
    pairs.forEach(([c, v], i) => {
      if (c === 0 && v === 'POLYLINE') {
        const f = pairs.slice(i + 1).find(([cc]) => cc === 70)
        const z = pairs.slice(i + 1).find(([cc]) => cc === 30)
        flags.push([Number(f[1]), z[1]])
      }
    })
    expect(flags).toEqual([[0, '120.0'], [1, '125.0'], [8, '0.0']])
  })

  it('keeps large coordinates exact and extents correct', () => {
    expect(text).toContain('\n500000.123456\n')
    expect(text).toContain('\n4200000.5\n')
    expect(text).not.toMatch(/\de[+-]?\d/i)
    const ext = pairs.findIndex(([c, v]) => c === 9 && v === '$EXTMAX')
    expect(pairs[ext + 1]).toEqual([10, '500010.0'])
    expect(pairs[ext + 2]).toEqual([20, '4200010.0'])
  })

  it('handles an empty document and skips one-vertex polylines', () => {
    const p = parseDxfPairs(writeDxf({ polylines: [{ layer: 'X', points: [[1, 1]] }] }))
    expect(count(p, 'POLYLINE')).toBe(0)
    expect(p[p.length - 1]).toEqual([0, 'EOF'])
  })

  it('does not mutate its input', () => {
    const d = { polylines: [{ layer: 'a b', points: [[1, 2], [3, 4]] }] }
    const snap = JSON.stringify(d)
    writeDxf(d)
    expect(JSON.stringify(d)).toBe(snap)
  })
})

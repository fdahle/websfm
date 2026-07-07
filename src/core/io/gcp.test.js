import { describe, it, expect } from 'vitest'
import {
  sniffDelimiter,
  parseRows,
  guessMapping,
  buildGcps,
} from './gcp.js'

describe('sniffDelimiter', () => {
  it('detects comma-separated data', () => {
    expect(sniffDelimiter('a,b,c\n1,2,3')).toBe('comma')
  })

  it('detects semicolons', () => {
    expect(sniffDelimiter('a;b;c;d')).toBe('semicolon')
  })

  it('detects tabs', () => {
    expect(sniffDelimiter('a\tb\tc')).toBe('tab')
  })

  it('detects whitespace-separated data', () => {
    expect(sniffDelimiter('a b c d e')).toBe('space')
  })

  it('picks the delimiter yielding the most columns on the first content line', () => {
    // Commas split into 4 columns, semicolons into 2 → comma wins.
    expect(sniffDelimiter('a,b,c,d;e')).toBe('comma')
  })

  it('skips comment and blank lines when sniffing', () => {
    expect(sniffDelimiter('# header comment\n\nx;y;z')).toBe('semicolon')
  })

  it('defaults to comma on empty input', () => {
    expect(sniffDelimiter('')).toBe('comma')
    expect(sniffDelimiter('# only a comment')).toBe('comma')
  })
})

describe('parseRows', () => {
  it('splits a header + data rows into a rectangular grid of trimmed cells', () => {
    const rows = parseRows('name, x, y\nA, 1, 2\nB, 3, 4', 'comma')
    expect(rows).toEqual([
      ['name', 'x', 'y'],
      ['A', '1', '2'],
      ['B', '3', '4'],
    ])
  })

  it('drops blank lines and trailing newlines', () => {
    const rows = parseRows('A,1\n\nB,2\n', 'comma')
    expect(rows).toEqual([['A', '1'], ['B', '2']])
  })

  it('drops #-comment lines', () => {
    const rows = parseRows('# a comment\nA,1\n   # indented comment\nB,2', 'comma')
    expect(rows).toEqual([['A', '1'], ['B', '2']])
  })

  it('collapses runs of whitespace for the space delimiter', () => {
    expect(parseRows('A    1   2', 'space')).toEqual([['A', '1', '2']])
  })
})

describe('guessMapping', () => {
  it('maps header names to roles case-insensitively', () => {
    const m = guessMapping(['Name', 'X', 'Y', 'Z'], 4, true)
    expect(m).toMatchObject({ name: 0, x: 1, y: 2, z: 3 })
  })

  it('recognises geographic aliases', () => {
    const m = guessMapping(['label', 'lon', 'lat', 'height'], 4, true)
    expect(m).toMatchObject({ name: 0, x: 1, y: 2, z: 3 })
  })

  it('maps image observation columns only from the header', () => {
    const m = guessMapping(['id', 'x', 'y', 'z', 'image', 'col', 'row'], 7, true)
    expect(m).toMatchObject({ image: 4, px: 5, py: 6 })
  })

  it('falls back to positional columns when there is no header', () => {
    const m = guessMapping([], 4, false)
    expect(m).toMatchObject({ name: 0, x: 1, y: 2, z: 3 })
    // Image observation columns are never guessed positionally.
    expect(m.image).toBeNull()
    expect(m.px).toBeNull()
    expect(m.py).toBeNull()
  })

  it('does not assign positional columns beyond columnCount', () => {
    const m = guessMapping([], 2, false)
    expect(m).toMatchObject({ name: 0, x: 1, y: null, z: null })
  })

  it('fills unmatched roles positionally around header-matched ones', () => {
    // Header only names z; name/x/y fall back to free columns 0/1/2.
    const m = guessMapping(['a', 'b', 'c', 'elevation'], 4, true)
    expect(m).toMatchObject({ z: 3, name: 0, x: 1, y: 2 })
  })
})

describe('buildGcps', () => {
  const mapping = { name: 0, x: 1, y: 2, z: 3, image: null, px: null, py: null }

  it('builds numeric GCPs from valid rows', () => {
    const { gcps, skipped } = buildGcps(
      [['A', '10.5', '20.5', '5'], ['B', '1', '2', '3']],
      mapping,
    )
    expect(skipped).toBe(0)
    expect(gcps).toEqual([
      { name: 'A', x: 10.5, y: 20.5, z: 5, observations: [] },
      { name: 'B', x: 1, y: 2, z: 3, observations: [] },
    ])
  })

  it('skips rows without a name', () => {
    const { gcps, skipped } = buildGcps([['', '1', '2', '3']], mapping)
    expect(gcps).toHaveLength(0)
    expect(skipped).toBe(1)
  })

  it('skips GCPs missing a valid X/Y position', () => {
    const { gcps, skipped } = buildGcps(
      [['A', 'not-a-number', '2', '3']],
      mapping,
    )
    expect(gcps).toHaveLength(0)
    expect(skipped).toBe(1)
  })

  it('leaves z null when the z cell is non-numeric', () => {
    const { gcps } = buildGcps([['A', '1', '2', 'NaN']], mapping)
    expect(gcps[0].z).toBeNull()
  })

  it('merges rows sharing a name and collects observations', () => {
    const withObs = { name: 0, x: 1, y: 2, z: 3, image: 4, px: 5, py: 6 }
    const { gcps } = buildGcps(
      [
        ['A', '1', '2', '3', 'img1.jpg', '100', '200'],
        ['A', '', '', '', 'img2.jpg', '110', '210'],
      ],
      withObs,
    )
    expect(gcps).toHaveLength(1)
    expect(gcps[0]).toMatchObject({ name: 'A', x: 1, y: 2, z: 3 })
    expect(gcps[0].observations).toEqual([
      { imageName: 'img1.jpg', px: 100, py: 200 },
      { imageName: 'img2.jpg', px: 110, py: 210 },
    ])
  })

  it('takes the first coordinates seen for a merged name', () => {
    const { gcps } = buildGcps(
      [['A', '1', '2', '3'], ['A', '9', '9', '9']],
      mapping,
    )
    expect(gcps).toHaveLength(1)
    expect(gcps[0]).toMatchObject({ x: 1, y: 2, z: 3 })
  })

  it('drops an observation with a non-numeric pixel coordinate', () => {
    const withObs = { name: 0, x: 1, y: 2, z: 3, image: 4, px: 5, py: 6 }
    const { gcps } = buildGcps(
      [['A', '1', '2', '3', 'img.jpg', 'x', '200']],
      withObs,
    )
    expect(gcps[0].observations).toHaveLength(0)
  })
})

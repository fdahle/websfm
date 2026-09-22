import { describe, it, expect } from 'vitest'
import {
  sniffDelimiter,
  parseRows,
  guessMapping,
  buildGcps,
  hasGcpElevation,
  normalizeGcpRole,
  isGroundControl,
} from './gcp.js'

describe('hasGcpElevation', () => {
  it('distinguishes a real zero elevation from a missing value', () => {
    expect(hasGcpElevation({ z: 0 })).toBe(true)
    expect(hasGcpElevation({ z: null })).toBe(false)
    expect(hasGcpElevation({})).toBe(false)
  })
})

describe('normalizeGcpRole', () => {
  it('recognises checkpoint aliases and defaults everything else to control', () => {
    expect(normalizeGcpRole('Check Point')).toBe('check')
    expect(normalizeGcpRole('validation')).toBe('check')
    expect(normalizeGcpRole('GCP')).toBe('control')
    expect(normalizeGcpRole(null)).toBe('control')
    // A marker MUST round-trip: collapsing it to 'control' would reload a
    // scale-bar endpoint from disk as ground control at whatever coordinates
    // the table happens to hold (D4).
    expect(normalizeGcpRole('marker')).toBe('marker')
    expect(normalizeGcpRole('Scale Bar')).toBe('marker')
    expect(normalizeGcpRole('scale_marker')).toBe('marker')
  })
})

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

  it('recognises common per-axis accuracy headers', () => {
    const m = guessMapping(['name', 'x', 'y', 'z', 'sigma_x', 'accY', 'accuracyZ'], 7, true)
    expect(m).toMatchObject({ accuracyX: 4, accuracyY: 5, accuracyZ: 6 })
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
      { name: 'A', role: 'control', x: 10.5, y: 20.5, z: 5,
        accuracyX: null, accuracyY: null, accuracyZ: null,
        correlationXY: null, correlationXZ: null, correlationYZ: null, observations: [] },
      { name: 'B', role: 'control', x: 1, y: 2, z: 3,
        accuracyX: null, accuracyY: null, accuracyZ: null,
        correlationXY: null, correlationXZ: null, correlationYZ: null, observations: [] },
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
      { imageName: 'img1.jpg', px: 100, py: 200, accuracyX: null, accuracyY: null },
      { imageName: 'img2.jpg', px: 110, py: 210, accuracyX: null, accuracyY: null },
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

  it('imports a role column and lets checkpoint win across repeated rows', () => {
    const withRole = { ...mapping, role: 4 }
    const { gcps } = buildGcps([
      ['A', '1', '2', '3', 'control'],
      ['A', '', '', '', 'check point'],
      ['B', '4', '5', '6', 'gcp'],
    ], withRole)
    expect(gcps.map((g) => [g.name, g.role])).toEqual([['A', 'check'], ['B', 'control']])
  })

  it('imports marker observations without surveyed coordinates', () => {
    const withMarker = {
      name: 0, role: 1, x: 2, y: 3, z: 4, image: 5, px: 6, py: 7,
    }
    const { gcps, skipped } = buildGcps([
      ['scale-a', 'marker', '', '', '', 'img.jpg', '100.5', '200.5'],
    ], withMarker)
    expect(skipped).toBe(0)
    expect(gcps).toHaveLength(1)
    expect(gcps[0]).toMatchObject({ name: 'scale-a', role: 'marker', x: null, y: null, z: null })
    expect(gcps[0].observations).toEqual([
      { imageName: 'img.jpg', px: 100.5, py: 200.5, accuracyX: null, accuracyY: null },
    ])
  })

  it('rejects marker rows that have neither coordinates nor an observation', () => {
    const { gcps, skipped } = buildGcps([
      ['scale-a', 'marker', '', '', '', '', '', ''],
    ], { name: 0, role: 1, x: 2, y: 3, z: 4, image: 5, px: 6, py: 7 })
    expect(gcps).toEqual([])
    expect(skipped).toBe(1)
  })

  it('maps positive per-axis accuracy and ignores invalid values', () => {
    const withAccuracy = { ...mapping, accuracyX: 4, accuracyY: 5, accuracyZ: 6 }
    const { gcps } = buildGcps([
      ['A', '1', '2', '3', '0.02', '0.03', '0.05'],
      ['B', '4', '5', '6', '0', '-1', 'nope'],
    ], withAccuracy)
    expect(gcps[0]).toMatchObject({ accuracyX: 0.02, accuracyY: 0.03, accuracyZ: 0.05 })
    expect(gcps[1]).toMatchObject({ accuracyX: null, accuracyY: null, accuracyZ: null })
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

describe('isGroundControl', () => {
  const surveyed = {
    role: 'control', enabled: true, x: 1, y: 2, z: 3,
    accuracyX: 0.01, accuracyY: 0.01, accuracyZ: 0.02,
  }
  const precision = (g) => (g.accuracyX > 0 && g.accuracyY > 0 && g.accuracyZ > 0 ? {} : null)

  it('accepts an enabled control point with coordinates and a precision', () => {
    expect(isGroundControl(surveyed, { precision })).toBe(true)
  })

  it('rejects a MARKER even with deliberately finite coordinates and accuracy', () => {
    // The whole point of D4: a marker that somehow acquires a full surveyed
    // record — migrated, imported, or edited by accident — still must not
    // constrain georeferencing, anchored BA or the leave-one-out report.
    expect(isGroundControl({ ...surveyed, role: 'marker' }, { precision })).toBe(false)
  })

  it('rejects checkpoints, disabled points, and missing coordinates', () => {
    expect(isGroundControl({ ...surveyed, role: 'check' }, { precision })).toBe(false)
    expect(isGroundControl({ ...surveyed, enabled: false }, { precision })).toBe(false)
    expect(isGroundControl({ ...surveyed, z: null }, { precision })).toBe(false)
    expect(isGroundControl({ ...surveyed, x: NaN }, { precision })).toBe(false)
    expect(isGroundControl(null, { precision })).toBe(false)
  })

  it('rejects a point whose covariance the caller cannot resolve', () => {
    expect(isGroundControl({ ...surveyed, accuracyZ: null }, { precision })).toBe(false)
  })

  it('treats an absent role as control (back-compat with older projects)', () => {
    const { role, ...noRole } = surveyed
    expect(isGroundControl(noRole, { precision })).toBe(true)
  })
})

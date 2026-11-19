import { describe, it, expect } from 'vitest'
import { georefEvidenceKey, currentEvidenceKey, evidenceChanges, evidenceChangeText } from './georefEvidence.js'

const evidence = (o = {}) => ({
  crs: 'EPSG:32636',
  model: 'm1',
  cameras: [['u1', { K: [5675.3, 0, 3000], R: new Float64Array([1, 0, 0, 0, 1, 0, 0, 0, 1]), t: [0, 0, -0] }]],
  images: [[1, 'u1']],
  gcps: [
    {
      id: 'g1',
      name: 'G1',
      role: 'control',
      x: 1,
      y: 2,
      z: 3,
      accuracyX: 0.02,
      accuracyY: 0.02,
      accuracyZ: 0.05,
      accuracyStatus: 'declared',
      observations: [
        { imageId: 1, imageName: 'img_001', px: 10.5, py: 20.25 },
        { imageId: 2, imageName: 'img_002', px: 30, py: 40 },
      ],
    },
  ],
  poses: [
    { id: 'p1', imageId: 1, imageName: 'img_001', x: 414089.3216528354, y: 6635152.056354913, z: 225.157, omega: null },
  ],
  ...o,
})

describe('the evidence a georeference was fitted on', () => {
  it("does not change when a linked record takes its photo's name", () => {
    const renamed = evidence({
      poses: [{ ...evidence().poses[0], imageName: 'IMG_001.JPG' }],
      gcps: [
        {
          ...evidence().gcps[0],
          observations: [
            { ...evidence().gcps[0].observations[0], imageName: 'IMG_001.JPG' },
            evidence().gcps[0].observations[1],
          ],
        },
      ],
    })
    expect(georefEvidenceKey(renamed)).toBe(georefEvidenceKey(evidence()))
  })

  it('changes with what the fit used: a position, a link, a mark, the model', () => {
    const base = georefEvidenceKey(evidence())
    expect(georefEvidenceKey(evidence({ poses: [{ ...evidence().poses[0], z: 225.2 }] }))).not.toBe(base)
    expect(georefEvidenceKey(evidence({ poses: [{ ...evidence().poses[0], imageId: 2 }] }))).not.toBe(base)
    const gcp = evidence().gcps[0]
    expect(
      georefEvidenceKey(
        evidence({ gcps: [{ ...gcp, observations: [{ ...gcp.observations[0], px: 10.6 }, gcp.observations[1]] }] }),
      ),
    ).not.toBe(base)
    expect(georefEvidenceKey(evidence({ model: 'm2' }))).not.toBe(base)
  })

  it('changes with a GCP the fit uses: its position, its accuracy, a third mark, its role', () => {
    const base = georefEvidenceKey(evidence())
    const gcp = evidence().gcps[0]
    const withGcp = (g) => georefEvidenceKey(evidence({ gcps: [g] }))
    expect(withGcp({ ...gcp, z: 3.1 })).not.toBe(base)
    expect(withGcp({ ...gcp, accuracyZ: 0.1 })).not.toBe(base)
    expect(withGcp({ ...gcp, observations: [...gcp.observations, { imageId: 3, px: 1, py: 2 }] })).not.toBe(base)
    expect(withGcp({ ...gcp, role: 'check' })).not.toBe(base)
    expect(withGcp({ ...gcp, enabled: false })).not.toBe(base)
  })

  it('does not change with a GCP the fit cannot use, or with what the fit does not read', () => {
    const base = georefEvidenceKey(evidence())
    const gcp = evidence().gcps[0]
    const plus = (g) => georefEvidenceKey(evidence({ gcps: [gcp, g] }))
    // A new point: no coordinates, no marks.
    expect(plus({ id: 'g2', role: 'control', x: null, y: null, z: null, observations: [] })).toBe(base)
    // Coordinates and one mark: it cannot be triangulated yet.
    expect(plus({ ...gcp, id: 'g2', observations: [gcp.observations[0]] })).toBe(base)
    // Marked twice, but no Z yet, no accuracy, a checkpoint, a marker.
    expect(plus({ ...gcp, id: 'g2', z: null })).toBe(base)
    expect(plus({ ...gcp, id: 'g2', accuracyZ: null })).toBe(base)
    expect(plus({ ...gcp, id: 'g2', role: 'check' })).toBe(base)
    expect(plus({ ...gcp, id: 'g2', role: 'marker', x: null, y: null, z: null })).toBe(base)
    // A rename, and accepting a detected mark where it is.
    expect(georefEvidenceKey(evidence({ gcps: [{ ...gcp, name: 'North pillar' }] }))).toBe(base)
    const detected = {
      ...gcp,
      observations: [{ ...gcp.observations[0], source: 'detected', score: 0.9 }, gcp.observations[1]],
    }
    expect(georefEvidenceKey(evidence({ gcps: [detected] }))).toBe(base)
  })

  it('reads a key saved with every GCP as the evidence of the ones the fit used', () => {
    const gcp = evidence().gcps[0]
    const bare = { id: 'g2', name: 'GCP 2', role: 'control', x: 0, y: 0, z: null, observations: [] }
    const saved = JSON.stringify(evidence({ gcps: [gcp, bare] })) // as keys were written before
    expect(currentEvidenceKey(saved)).toBe(georefEvidenceKey(evidence()))
    expect(currentEvidenceKey(currentEvidenceKey(saved))).toBe(currentEvidenceKey(saved))
  })

  it('reads a key saved with the names as the same evidence, whatever the names became', () => {
    const saved = JSON.stringify(evidence()) // as keys were written before
    expect(saved).toContain('img_001')
    expect(currentEvidenceKey(saved)).toBe(georefEvidenceKey(evidence()))
    const now = evidence({ poses: [{ ...evidence().poses[0], imageName: 'IMG_001.JPG' }] })
    expect(currentEvidenceKey(saved)).toBe(georefEvidenceKey(now))
    expect(currentEvidenceKey(saved)).not.toBe(georefEvidenceKey(evidence({ model: 'm2' })))
  })

  it('leaves a key in the current form, a missing one and a broken one as they are', () => {
    const key = georefEvidenceKey(evidence())
    expect(currentEvidenceKey(key)).toBe(key)
    expect(currentEvidenceKey(undefined)).toBe(undefined)
    expect(currentEvidenceKey(null)).toBe(null)
    expect(currentEvidenceKey('{broken')).toBe('{broken')
  })
})

describe('what changed since a georeference was fitted', () => {
  const key = (o) => georefEvidenceKey(evidence(o))

  it('names the part and the records that moved, and which of their fields', () => {
    const now = key({
      poses: [
        { ...evidence().poses[0], z: 230 },
        { id: 'p2', imageId: 2, x: 1, y: 2, z: 3 },
      ],
    })
    const changes = evidenceChanges(key(), now)
    expect(changes).toEqual([
      {
        part: 'poses',
        name: 'the camera positions',
        added: 1,
        removed: 0,
        changed: 1,
        examples: [{ key: 'p1', fields: ['z'] }],
      },
    ])
    expect(evidenceChangeText(changes)).toBe('the camera positions (1 added, 1 edited)')
  })

  it('tells a photo removed from a rebuilt model, in words for the log', () => {
    const changes = evidenceChanges(key(), key({ model: 'm2', images: [] }))
    expect(changes.map((c) => c.part)).toEqual(['model', 'images'])
    expect(evidenceChangeText(changes)).toBe('the sparse model and the photos (1 removed)')
  })

  it('finds nothing in a key saved before names were left out, when nothing else changed', () => {
    const old = JSON.stringify(evidence())
    expect(evidenceChanges(old, key())).toEqual([])
  })
})

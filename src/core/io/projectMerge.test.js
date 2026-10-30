import { describe, it, expect } from 'vitest'
import { planProjectMerge, photoKey, freeLabel, sameCalibration } from './projectMerge.js'

const photo = (name, uuid, extra = {}) => ({
  id: `${name}-100-0`,
  uuid,
  name,
  sourceName: name,
  sensorId: 's-sony',
  meta: { fileSize: 100, width: 4000, height: 3000, dateTime: `2026-06-01T10:00:${name.slice(3, 5)}Z` },
  ...extra,
})
const sony = { id: 's-sony', width: 4000, height: 3000, focal: 4.5, focalUnit: 'mm', distortionModel: 'pinhole' }

describe('planProjectMerge', () => {
  const target = {
    images: [photo('DSC10.JPG', 'a1'), photo('DSC11.JPG', 'a2'), photo('DSC12.JPG', 'a3')],
    sensors: [{ ...sony, id: 'a-sony' }],
    gcps: [{ name: 'GCP1', x: 1, y: 2, z: 3, observations: [{ imageName: 'DSC10.JPG', px: 5, py: 5 }] }],
    poses: [],
  }
  const source = {
    images: [
      photo('DSC12.JPG', 'b0'), // the same photo as A's a3
      photo('DSC13.JPG', 'b1'),
      // Another camera's photo that happens to share a label with A's.
      photo('DSC10.JPG', 'b2', { sensorId: 's-canon', meta: { fileSize: 999, width: 6000, height: 4000 } }),
    ],
    sensors: [sony, { id: 's-canon', width: 6000, height: 4000, focal: 24, focalUnit: 'mm' }],
    gcps: [
      { name: 'GCP1', x: 1, y: 2, z: 3, observations: [{ imageName: 'DSC13.JPG', px: 7, py: 8 }] },
      { name: 'GCP9', x: 9, y: 9, z: 9, observations: [{ imageName: 'DSC12.JPG', px: 1, py: 1 }] },
      { name: 'M1', x: null, y: null, observations: [{ imageName: 'gone.JPG', px: 1, py: 1 }] },
    ],
    poses: [
      { imageName: 'DSC13.JPG', source: 'imported', x: 1, y: 2, z: 3 },
      { imageName: 'DSC10.JPG', source: 'exif', x: 1, y: 2, z: 3 },
    ],
  }
  const plan = planProjectMerge({ target, source })

  it('keeps a photo both projects hold once, and renames a clashing label', () => {
    expect(plan.shared.map((s) => [s.source.uuid, s.target.uuid])).toEqual([['b0', 'a3']])
    expect(plan.added.map((a) => [a.image.uuid, a.name])).toEqual([
      ['b1', 'DSC13.JPG'],
      ['b2', 'DSC10 (2).JPG'],
    ])
    expect(plan.nameOf.get('DSC12.JPG')).toBe('DSC12.JPG')
    expect(plan.nameOf.get('DSC10.JPG')).toBe('DSC10 (2).JPG')
  })

  it('joins an identical sensor and brings a new one', () => {
    expect(plan.sensors.map.get('s-sony')).toBe('a-sony')
    expect(plan.sensors.map.get('s-canon')).toBe('s-canon')
    expect(plan.sensors.add.map((s) => s.id)).toEqual(['s-canon'])
  })

  it('moves marks onto A labels, drops marks with nowhere to go, keeps imported poses', () => {
    expect(plan.gcps.map((g) => [g.name, g.observations.map((o) => o.imageName)])).toEqual([
      ['GCP1', ['DSC13.JPG']],
      ['GCP9', ['DSC12.JPG']],
    ])
    // A's GCP1 keeps its position: B's comes without coordinates, only its marks.
    expect(plan.gcps[0]).toMatchObject({ x: null, y: null, z: null })
    expect(plan.gcps[1]).toMatchObject({ x: 9, y: 9, z: 9 })
    expect(plan.poses.map((p) => p.imageName)).toEqual(['DSC13.JPG'])
  })

  it("keeps B's pairs between photos that come in, never one on a shared photo", () => {
    expect(plan.keepPair('b1', 'b2')).toBe(true)
    expect(plan.keepPair('b0', 'b1')).toBe(false)
  })

  it('treats a uuid A already holds as the same photo (B was made from A)', () => {
    const p = planProjectMerge({ target, source: { images: [photo('renamed.JPG', 'a2', { meta: {} })] } })
    expect(p.shared[0].target.uuid).toBe('a2')
    expect(p.added).toEqual([])
  })
})

describe('helpers', () => {
  it('names the next free label', () => {
    expect(freeLabel('a.jpg', new Set(['a.jpg', 'a (2).jpg']))).toBe('a (3).jpg')
    expect(freeLabel('noext', new Set(['noext']))).toBe('noext (2)')
  })
  it('compares calibrations, film calibrations included', () => {
    expect(sameCalibration(sony, { ...sony, id: 'x' })).toBe(true)
    expect(sameCalibration(sony, { ...sony, focal: 4.6 })).toBe(false)
    expect(sameCalibration({ ...sony, fiducialCalibration: { a: 1 } }, sony)).toBe(false)
  })
  it('keys a photo by file, not by label', () => {
    expect(photoKey(photo('X.JPG', 'u'))).toBe(photoKey({ ...photo('X.JPG', 'v'), name: 'renamed' }))
  })
})

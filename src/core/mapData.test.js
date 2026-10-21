import { describe, it, expect } from 'vitest'
import {
  gpsImagesOf,
  plottedGcps,
  modelMarkerGcps,
  gcpPlacement,
  plottedFootprints,
  plottedPoses,
  modelCameraPoses,
  isUnaligned,
  hoverText,
  linkedImageOf,
} from './mapData.js'
// The map's OL feature factories and style functions: what they set is what
// hoverText / linkedImageOf / the click handler read back, so the property names
// are a contract between the two halves. Both are DOM-free and load in node.
import {
  makeImageFeature,
  makeGcpFeature,
  makeFootprintFeature,
  makePoseFeature,
} from '../components/viewers/map/mapFeatures.js'
import { imageStyle, gcpStyle, poseStyle, footprintStyle } from '../components/viewers/map/mapStyles.js'

const feature = (props) => ({ get: (k) => props[k] })

describe('gpsImagesOf', () => {
  const images = [
    { id: 'a', meta: { gpsLat: 1, gpsLon: 2 } },
    { id: 'b', meta: { gpsLat: 1 } },
    { id: 'c' },
    { id: 'd', meta: { gpsLat: 0, gpsLon: 0 } },
    { id: 'e', meta: { gpsLat: 3, gpsLon: 4 } },
  ]

  it('keeps images with both GPS coordinates (0 counts)', () => {
    expect(gpsImagesOf(images, []).map((i) => i.id)).toEqual(['a', 'd', 'e'])
  })

  it('drops an image an enabled pose supersedes, not one whose pose is disabled', () => {
    const poses = [{ imageId: 'a' }, { imageId: 'e', enabled: false }]
    expect(gpsImagesOf(images, poses).map((i) => i.id)).toEqual(['d', 'e'])
  })
})

describe('GCP markers', () => {
  it('plots enabled GCPs with a finite position, copying what a marker draws', () => {
    const gcps = [
      { id: '1', name: 'A', x: 1, y: 2, role: 'check', z: 9, extra: true },
      { id: '2', name: 'B', x: NaN, y: 2 },
      { id: '3', name: 'C', x: 1, y: 2, enabled: false },
      { id: '4', name: 'D', x: 0, y: 0 },
    ]
    expect(plottedGcps(gcps)).toEqual([
      { id: '1', name: 'A', x: 1, y: 2, role: 'check' },
      { id: '4', name: 'D', x: 0, y: 0, role: undefined },
    ])
  })

  it('returns fresh records, so a rename in place yields a different value', () => {
    const g = { id: '1', name: 'A', x: 1, y: 2 }
    const before = plottedGcps([g])
    g.name = 'Renamed'
    expect(plottedGcps([g])[0].name).toBe('Renamed')
    expect(before[0].name).toBe('A')
  })

  it('turns model-frame markers into marker-role records', () => {
    expect(modelMarkerGcps([{ id: 'm', name: 'M', x: 3, y: 4, extra: 1 }])).toEqual([
      { id: 'm', name: 'M', x: 3, y: 4, role: 'marker' },
    ])
  })

  it('placement changes on a move / add / remove, not on a rename or role change', () => {
    const base = [
      { id: '1', name: 'A', x: 1, y: 2, role: 'control' },
      { id: '2', name: 'B', x: 3, y: 4 },
    ]
    const key = gcpPlacement(base)
    expect(gcpPlacement([{ ...base[0], name: 'Z', role: 'check' }, base[1]])).toBe(key)
    expect(gcpPlacement([{ ...base[0], x: 1.5 }, base[1]])).not.toBe(key)
    expect(gcpPlacement([base[0]])).not.toBe(key)
    expect(gcpPlacement([...base, { id: '3', x: 0, y: 0 }])).not.toBe(key)
    expect(gcpPlacement([])).toBe('')
  })
})

describe('footprints and poses', () => {
  it('plots enabled footprints that have rings', () => {
    const fps = [
      { id: 'a', rings: [[[0, 0]]] },
      { id: 'b', rings: [] },
      { id: 'c' },
      { id: 'd', rings: [[[0, 0]]], enabled: false },
    ]
    expect(plottedFootprints(fps).map((f) => f.id)).toEqual(['a'])
  })

  it('plots enabled poses with a finite position', () => {
    const poses = [
      { imageId: 'a', x: 1, y: 2 },
      { imageId: 'b', x: 1 },
      { imageId: 'c', x: 1, y: 2, enabled: false },
    ]
    expect(plottedPoses(poses).map((p) => p.imageId)).toEqual(['a'])
  })

  it('turns model cameras into sfm-sourced pose records', () => {
    expect(modelCameraPoses([{ imageId: 'i', imageName: 'I', x: 1, y: 2, extra: 0 }])).toEqual([
      { x: 1, y: 2, imageId: 'i', imageName: 'I', source: 'sfm' },
    ])
  })
})

describe('isUnaligned', () => {
  const aligned = new Set(['u1'])
  it('is only true once a sparse model exists and the uuid is missing from it', () => {
    expect(isUnaligned('u2', true, aligned)).toBe(true)
    expect(isUnaligned('u1', true, aligned)).toBe(false)
    expect(isUnaligned('u2', false, aligned)).toBe(false)
    expect(isUnaligned(null, true, aligned)).toBe(false)
    expect(isUnaligned(undefined, true, aligned)).toBe(false)
  })
})

describe('hoverText', () => {
  it('names the feature by kind, GCP first', () => {
    expect(hoverText(feature({ gcpName: 'P1', gcpRole: 'control' }), false)).toBe('GCP: P1')
    expect(hoverText(feature({ gcpName: 'P1', gcpRole: 'check' }), false)).toBe('GCP: P1')
    expect(hoverText(feature({ gcpName: 'M1', gcpRole: 'marker' }), true)).toBe('Marker: M1')
    expect(hoverText(feature({ footprintName: 'img.tif', name: 'x' }), true)).toBe('Footprint: img.tif')
    expect(hoverText(feature({ poseName: 'img.jpg' }), true)).toBe('Camera: img.jpg')
  })

  it('marks an unaligned image GPS marker', () => {
    expect(hoverText(feature({ name: 'img.jpg' }), false)).toBe('img.jpg')
    expect(hoverText(feature({ name: 'img.jpg' }), true)).toBe('img.jpg (not aligned)')
  })
})

describe('linkedImageOf', () => {
  const images = [{ id: 'a', name: 'A' }]
  it('resolves only a link to a loaded image', () => {
    expect(linkedImageOf(feature({ imgId: 'a' }), images)).toBe(images[0])
    expect(linkedImageOf(feature({ imgId: 'gone' }), images)).toBeNull()
    expect(linkedImageOf(feature({}), images)).toBeNull()
  })
})

describe('feature factories ↔ readers', () => {
  it('a GCP feature carries id, name and role (control by default)', () => {
    const f = makeGcpFeature({ id: 'g', name: 'P1', x: 5, y: 6 })
    expect(f.getGeometry().getCoordinates()).toEqual([5, 6])
    expect(f.get('gcpId')).toBe('g')
    expect(f.get('gcpRole')).toBe('control')
    expect(hoverText(f, false)).toBe('GCP: P1')
    expect(makeGcpFeature({ id: 'm', name: 'M', x: 0, y: 0, role: 'marker' }).get('gcpRole')).toBe('marker')
  })

  it('a footprint links its image and names it, else the set', () => {
    const f = makeFootprintFeature({
      rings: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
      imageId: 'a',
      imageName: 'A.tif',
      name: 'set',
    })
    expect(f.get('imgId')).toBe('a')
    expect(hoverText(f, false)).toBe('Footprint: A.tif')
    expect(linkedImageOf(f, [{ id: 'a' }])).toEqual({ id: 'a' })
    const loose = makeFootprintFeature({
      rings: [
        [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 0],
        ],
      ],
      setName: 'Blocks',
      name: 'x',
    })
    expect(loose.get('imgId')).toBeUndefined()
    expect(hoverText(loose, false)).toBe('Footprint: Blocks')
  })

  it('a pose links its image and keeps its source (imported by default)', () => {
    const f = makePoseFeature({ x: 1, y: 2, imageId: 'a', imageName: 'A.jpg' })
    expect(f.get('imgId')).toBe('a')
    expect(f.get('poseSource')).toBe('imported')
    expect(hoverText(f, false)).toBe('Camera: A.jpg')
    expect(makePoseFeature({ x: 1, y: 2, source: 'exif' }).get('poseSource')).toBe('exif')
  })

  it('an image GPS feature is projected from WGS84 into the view CRS', () => {
    const f = makeImageFeature({ id: 'a', uuid: 'u', name: 'A.jpg', meta: { gpsLon: 10, gpsLat: 20 } }, 'EPSG:4326')
    expect(f.getGeometry().getCoordinates()).toEqual([10, 20])
    expect(f.get('imgId')).toBe('a')
    expect(f.get('uuid')).toBe('u')
    expect(hoverText(f, true)).toBe('A.jpg (not aligned)')
  })
})

describe('style functions', () => {
  const img = makeImageFeature({ id: 'a', uuid: 'u', name: 'A', meta: { gpsLon: 0, gpsLat: 0 } }, 'EPSG:4326')

  it('a selected image marker wins over the unaligned look; the predicate is not asked then', () => {
    let asked = 0
    const unaligned = () => {
      asked++
      return true
    }
    const selected = imageStyle(img, 'a', unaligned)
    expect(asked).toBe(0)
    const faded = imageStyle(img, 'other', unaligned)
    const normal = imageStyle(img, 'other', () => false)
    expect(asked).toBe(1)
    expect(new Set([selected, faded, normal]).size).toBe(3)
  })

  it('GCP roles each get their own shape colour', () => {
    const styles = ['control', 'check', 'marker'].map((role) =>
      gcpStyle(makeGcpFeature({ id: 'g', name: 'G', x: 0, y: 0, role })),
    )
    expect(new Set(styles).size).toBe(3)
    expect(gcpStyle(makeGcpFeature({ id: 'g', name: 'G', x: 0, y: 0 }))).toBe(styles[0])
  })

  it('poses: selected, EXIF and imported differ', () => {
    const p = makePoseFeature({ x: 0, y: 0, imageId: 'a' })
    const e = makePoseFeature({ x: 0, y: 0, imageId: 'a', source: 'exif' })
    expect(new Set([poseStyle(p, 'a'), poseStyle(p, null), poseStyle(e, null)]).size).toBe(3)
    expect(poseStyle(e, 'a')).toBe(poseStyle(p, 'a'))
  })

  it('a footprint highlights only when linked to the selected image', () => {
    const ring = [
      [
        [0, 0],
        [1, 0],
        [1, 1],
        [0, 0],
      ],
    ]
    const linked = makeFootprintFeature({ rings: ring, imageId: 'a' })
    const loose = makeFootprintFeature({ rings: ring })
    expect(footprintStyle(linked, 'a')).not.toBe(footprintStyle(linked, 'b'))
    expect(footprintStyle(loose, undefined)).toBe(footprintStyle(linked, 'b'))
  })
})

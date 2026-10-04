import { describe, it, expect } from 'vitest'
import { buildCloudStyle, styleFields, scalarRange, sharedElevationRange, groupCloudLegends } from './cloudStyle.js'
import { viewerClipping } from './viewerClipping.js'
import { cropCloud, mergeClouds, voxelDownsample } from './cloudEdit.js'
import { serializeCloud, deserializeCloud } from '../../stores/reconstruction/cloudSerde.js'

function cloud() {
  return { id: 'a', kind: 'dense', name: 'Survey', cameras: new Map(), imported: true, count: 3,
    pos: new Float64Array([500000, 7000000, 10, 500000.01, 7000000, 20, 500005, 7000000, 30]),
    col: new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255]),
    attributes: { classification: new Uint8Array([2, 6, 2]), intensity: new Uint16Array([0, 32768, 65535]),
      gpsTime: new Float64Array([123456789.125, 123456789.25, 123456789.5]) } }
}
describe('cloud symbology and attributes', () => {
  it('hides classes with a draw index and leaves source coordinates, RGB and fields intact', () => {
    const c = cloud(), original = structuredClone(c)
    const out = buildCloudStyle(c, { field: 'attribute:classification', classes: { 6: { visible: false }, 2: { colour: '#123456' } } })
    expect([...out.indices]).toEqual([0, 2])
    expect([...out.colors.slice(0, 3)]).toEqual([18, 52, 86])
    expect(out.legend.entries.map(e => [e.value, e.count])).toEqual([[2, 2], [6, 1]])
    expect(c).toEqual(original)
  })
  it('styles scalar values with a shared manual range and handles missing values', () => {
    const c = cloud()
    const out = buildCloudStyle(c, { field: 'elevation', ramp: 'gray', range: 'manual', min: 0, max: 40 })
    expect([...out.colors]).toEqual([64, 64, 64, 128, 128, 128, 191, 191, 191])
    expect(out.legend.min).toBe(0)
    c.attributes.gpsTime[1] = NaN
    expect(scalarRange(c, 'attribute:gpsTime')).toEqual({ min: 123456789.125, max: 123456789.5 })
    expect([...buildCloudStyle(c, { field: 'attribute:gpsTime' }).colors.slice(3, 6)]).toEqual([160, 160, 160])
    expect(styleFields(c).some(f => f.value === 'attribute:nir')).toBe(false)
  })
  it('round-trips typed attributes, class styling and visibility through the project representation', () => {
    const c = { ...cloud(), visible: false, style: { field: 'attribute:classification', classes: { 6: { visible: false } } } }
    const packed = serializeCloud(c)
    const out = deserializeCloud(structuredClone(packed), () => 'new')
    expect(out.attributes.intensity).toBeInstanceOf(Uint16Array)
    expect(out.attributes.gpsTime).toBeInstanceOf(Float64Array)
    expect(out.attributes).toEqual(c.attributes)
    expect(out.visible).toBe(false)
    expect(out.style).toEqual(c.style)
    expect([...out.pos]).toEqual([...c.pos])
    const broken = { ...packed, buffers: { ...packed.buffers, attributes: new ArrayBuffer(1) } }
    // A damaged attribute sidecar drops the attributes, not the cloud (nor the restore).
    const degraded = deserializeCloud(broken, () => 'new')
    expect(degraded.attributes).toBeUndefined()
    expect(degraded.attributeError).toMatch(/attribute/)
    expect([...degraded.pos]).toEqual([...c.pos])
  })
  it('retains corresponding attributes through crop, merge and representative subsampling', () => {
    const c = cloud()
    const cropped = cropCloud(c, { min: [0, 0, 15], max: [1e8, 1e8, 25] })
    expect([...cropped.attributes.classification]).toEqual([6])
    expect([...cropped.attributes.gpsTime]).toEqual([123456789.25])
    const merged = mergeClouds([c, cropped])
    expect([...merged.attributes.intensity]).toEqual([0, 32768, 65535, 32768])
    const sampled = voxelDownsample(c, { cell: 100 })
    expect(sampled.count).toBe(1)
    expect([...sampled.attributes.classification]).toEqual([2])
    expect([...sampled.pos]).toEqual([...c.pos.slice(0, 3)])
  })
})
describe('viewer clipping', () => {
  it('moves the near plane closer when zooming into a large survey and permits a manual override', () => {
    const distant = viewerClipping(10000, 10000)
    const close = viewerClipping(10000, 0.01)
    expect(close.near).toBeLessThan(0.00001)
    expect(close.near).toBeGreaterThan(0)
    expect(close.near).toBeLessThan(distant.near)
    expect(viewerClipping(10000, 0.01, 0.002).near).toBe(0.002)
    const far = viewerClipping(1, 1000000)
    expect(far.far).toBeGreaterThan(1000000)
  })
})

describe('shared scales and concise legends', () => {
  it('maps the same elevation to the same colour across files, retaining hidden clouds in the scale', () => {
    const a = { ...cloud(), style: { field: 'elevation' } }
    const b = { ...cloud(), id: 'b', visible: false, style: { field: 'elevation' }, pos: new Float64Array([0, 0, 30, 0, 0, 40, 0, 0, 50]) }
    const range = sharedElevationRange([a, b])
    expect(range).toEqual({ min: 10, max: 50 })
    const va = buildCloudStyle(a, undefined, { elevationRange: range })
    const vb = buildCloudStyle(b, undefined, { elevationRange: range })
    expect([...va.colors.slice(6, 9)]).toEqual([...vb.colors.slice(0, 3)])
    expect(groupCloudLegends([{ id: 'a', name: 'A', legend: va.legend }, { id: 'b', name: 'B', legend: vb.legend }])).toMatchObject([
      { names: ['A', 'B'], legend: { min: 10, max: 50, ramp: 'viridis' } },
    ])
    b.style.range = 'local'
    expect(sharedElevationRange([a, b])).toEqual({ min: 10, max: 30 })
    expect(buildCloudStyle(b, undefined, { elevationRange: range }).legend.min).toBe(30)
    b.style = { field: 'elevation', range: 'manual', min: -100, max: 100 }
    expect(buildCloudStyle(b, undefined, { elevationRange: range }).legend.min).toBe(-100)
  })

  it('omits RGB and invisible encodings, and keeps differing ramps or ranges separate', () => {
    const c = cloud()
    const layer = (id, style) => ({ id, name: id, legend: buildCloudStyle(c, style).legend })
    const groups = groupCloudLegends([
      layer('rgb', { field: 'rgb' }), layer('transparent', { field: 'elevation', opacity: 0 }),
      layer('hidden classes', { field: 'attribute:classification', classes: { 2: { visible: false }, 6: { visible: false } } }),
      layer('A', { field: 'elevation' }), layer('B', { field: 'elevation', ramp: 'gray' }),
      layer('C', { field: 'elevation', range: 'manual', min: 0, max: 100 }),
    ])
    expect(groups.map(g => g.names)).toEqual([['A'], ['B'], ['C']])
  })

  it('combines class legends with matching colours but separates conflicting class colours', () => {
    const c = cloud()
    const layers = [
      { id: 'a', name: 'A', legend: buildCloudStyle(c, { field: 'attribute:classification', classes: { 6: { visible: false } } }).legend },
      { id: 'b', name: 'B', legend: buildCloudStyle(c, { field: 'attribute:classification' }).legend },
      { id: 'c', name: 'C', legend: buildCloudStyle(c, { field: 'attribute:classification', classes: { 2: { colour: '#ffffff' } } }).legend },
    ]
    const original = structuredClone(layers)
    const groups = groupCloudLegends(layers)
    expect(groups.map(g => g.names)).toEqual([['A', 'B'], ['C']])
    expect(groups[0].legend.entries.map(e => e.value)).toEqual([2, 6])
    expect(layers).toEqual(original)
  })
})

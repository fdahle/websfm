import { describe, expect, it } from 'vitest'
import { isFootprintSet, vectorSection, vectorMapLayers, vectorLayerId } from './vectorLayers.js'

const ring = [
  [0, 0],
  [1, 0],
  [1, 1],
]
const footprints = { id: 'f', name: 'footprints', source: 'computed', footprints: [{ id: 'a', rings: [ring] }] }
const contours = {
  id: 'c',
  name: 'Contours 5 m',
  source: 'computed',
  kind: 'lines',
  footprints: [{ id: 'l', lines: [ring], level: 5 }],
}
const imported = {
  id: 'i',
  name: 'Site',
  source: 'imported',
  opacity: 0.5,
  footprints: [
    { id: 'p', rings: [ring], imageId: 'img-1' },
    { id: 'q', rings: [ring] },
  ],
}

describe('vector layers', () => {
  it('tells the footprint overlay from the layer sets', () => {
    expect([footprints, contours, imported].map(isFootprintSet)).toEqual([true, false, false])
    expect([footprints, contours, imported].map(vectorSection)).toEqual([null, 'products', 'reference'])
  })

  it('stacks every shown layer set, never the footprints', () => {
    const layers = vectorMapLayers([footprints, contours, imported, { ...imported, id: 'h', visible: false }])
    expect(layers.map((l) => [l.id, l.kind, l.opacity])).toEqual([
      [vectorLayerId('c'), 'lines', 1],
      [vectorLayerId('i'), 'polygons', 0.5],
    ])
    // The same list keeps its rev; a new list or a new image link changes it.
    expect(vectorMapLayers([imported])[0].rev).toBe(layers[1].rev)
    expect(vectorMapLayers([{ ...imported, footprints: [...imported.footprints] }])[0].rev).not.toBe(layers[1].rev)
    const relinked = { ...imported, footprints: imported.footprints.map((fp) => ({ ...fp, imageId: 'img-1' })) }
    expect(vectorMapLayers([relinked])[0].rev.endsWith(':2')).toBe(true)
    expect(layers[1].features()[0]).toMatchObject({ id: 'p', setId: 'i', setName: 'Site' })
  })
})

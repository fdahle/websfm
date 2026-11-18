import { describe, it, expect } from 'vitest'
import { mapLayerIds, stackMapLayers, moveMapLayer, normalizeMapOrder, reconcileList } from './mapOrder.js'

// Default order, bottom first: two reference rasters, then the DEM, then the ortho.
const defaults = ['rema', 'cop30', 'product:dem', 'product:ortho']

describe('mapLayerIds', () => {
  it('lists the default stack top first when nothing was reordered', () => {
    expect(mapLayerIds(defaults)).toEqual(['product:ortho', 'product:dem', 'cop30', 'rema'])
  })

  it('follows the stored order, puts a layer it does not name on top, and drops gone ones', () => {
    const order = ['product:dem', 'rema', 'gone', 'product:ortho']
    expect(mapLayerIds(defaults, order)).toEqual(['cop30', 'product:dem', 'rema', 'product:ortho'])
  })
})

describe('stackMapLayers', () => {
  it('returns the layers bottom first for drawing', () => {
    const layers = defaults.map((id) => ({ id }))
    expect(stackMapLayers(layers, ['rema', 'product:ortho', 'product:dem', 'cop30']).map((l) => l.id)).toEqual([
      'cop30',
      'product:dem',
      'product:ortho',
      'rema',
    ])
  })
})

describe('moveMapLayer', () => {
  it('moves a layer to an index, clamped', () => {
    const ids = ['a', 'b', 'c']
    expect(moveMapLayer(ids, 'c', 0)).toEqual(['c', 'a', 'b'])
    expect(moveMapLayer(ids, 'a', 9)).toEqual(['b', 'c', 'a'])
    expect(moveMapLayer(ids, 'x', 0)).toBe(ids)
  })
})

describe('normalizeMapOrder', () => {
  it('keeps distinct strings only', () => {
    expect(normalizeMapOrder(['a', 'a', 3, '', 'b'])).toEqual(['a', 'b'])
    expect(normalizeMapOrder(null)).toEqual([])
  })
})

describe('reconcileList', () => {
  // A collection that records every item it takes out.
  function list(items) {
    const a = [...items]
    const removed = []
    return {
      removed,
      getLength: () => a.length,
      item: (i) => a[i],
      getArray: () => a,
      insertAt: (i, x) => a.splice(i, 0, x),
      removeAt: (i) => removed.push(a.splice(i, 1)[0]),
    }
  }

  it('adds a layer on top without taking the others off the map', () => {
    const l = list(['dem', 'ortho'])
    reconcileList(l, ['dem', 'ortho', 'photos'])
    expect(l.getArray()).toEqual(['dem', 'ortho', 'photos'])
    expect(l.removed).toEqual([])
  })

  it('takes away only what left, and keeps the rest in place', () => {
    const l = list(['dem', 'ortho', 'photos'])
    reconcileList(l, ['dem', 'ortho'])
    expect(l.getArray()).toEqual(['dem', 'ortho'])
    expect(l.removed).toEqual(['photos'])
  })

  it('restacks a moved layer, leaving one already in its place alone', () => {
    const l = list(['dem', 'ortho', 'photos'])
    reconcileList(l, ['dem', 'photos', 'ortho'])
    expect(l.getArray()).toEqual(['dem', 'photos', 'ortho'])
    expect(l.removed).not.toContain('dem')
  })
})

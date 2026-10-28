import { describe, expect, it } from 'vitest'
import { mainOf, nextProductName, outdatedReasons, stampOf } from './productSet.js'

describe('nextProductName', () => {
  it('numbers a taken name', () => {
    expect(nextProductName('DEM', [])).toBe('DEM')
    expect(nextProductName('DEM', ['DEM'])).toBe('DEM 2')
    expect(nextProductName('DEM', ['DEM', 'DEM 2', 'Orthophoto'])).toBe('DEM 3')
  })
})

describe('mainOf', () => {
  const list = [
    { id: 'd1', kind: 'dem' },
    { id: 'o1', kind: 'ortho' },
    { id: 'd2', kind: 'dem' },
  ]
  it('takes the named one, else the newest of the kind', () => {
    expect(mainOf(list, 'dem', 'd1').id).toBe('d1')
    expect(mainOf(list, 'dem', 'gone').id).toBe('d2')
    expect(mainOf(list, 'dem', 'o1').id).toBe('d2')
    expect(mainOf(list, 'mesh', null)).toBeNull()
  })
  it('passes over an imported cloud unless it is named or alone', () => {
    const clouds = [
      { id: 'c1', kind: 'dense' },
      { id: 'i1', kind: 'dense', imported: true },
    ]
    expect(mainOf(clouds, 'dense', null).id).toBe('c1')
    expect(mainOf(clouds, 'dense', 'i1').id).toBe('i1')
    expect(mainOf([clouds[1]], 'dense', null).id).toBe('i1')
  })
})

describe('outdatedReasons', () => {
  const sparse = { id: 's', kind: 'sparse', name: 'Sparse cloud', createdAt: 1 }
  const dense = { id: 'c', kind: 'dense', name: 'Dense cloud', createdAt: 2, basedOn: [stampOf(sparse)] }
  const dem = { id: 'd', kind: 'dem', name: 'DEM', createdAt: 3, basedOn: [stampOf(dense)] }
  const ortho = { id: 'o', kind: 'ortho', name: 'Orthophoto', createdAt: 4, basedOn: [stampOf(dem), stampOf(sparse)] }
  const imported = { id: 'i', kind: 'dense', name: 'Survey', createdAt: 0 }

  it('finds nothing while every input is as it was', () => {
    expect(outdatedReasons([sparse, dense, dem, ortho, imported], { mainSparseId: 's' }).size).toBe(0)
  })

  it('marks the whole chain when the sparse model is rebuilt', () => {
    const rebuilt = { ...sparse, createdAt: 9 }
    const out = outdatedReasons([rebuilt, dense, dem, ortho, imported], { mainSparseId: 's' })
    expect(out.get('c')).toBe('the sparse model has changed since it was built')
    expect(out.get('d')).toBe('it was built on "Dense cloud", which is outdated')
    expect(out.get('o')).toBe('it was built on "DEM", which is outdated')
    // Nothing it was built from: an import is never outdated.
    expect(out.has('i')).toBe(false)
  })

  it('marks a product whose input was rebuilt in place', () => {
    const out = outdatedReasons([sparse, dense, { ...dem, createdAt: 8 }, ortho], { mainSparseId: 's' })
    expect(out.get('o')).toBe('"DEM" was rebuilt since')
    expect(out.has('d')).toBe(false)
  })

  it('keeps a product whose non-sparse input was removed', () => {
    expect(outdatedReasons([sparse, dem], { mainSparseId: 's' }).has('d')).toBe(false)
  })

  it('marks products of a sparse model that is not the main one, or is gone', () => {
    const other = { id: 's2', kind: 'sparse', name: 'COLMAP import', createdAt: 5 }
    const out = outdatedReasons([sparse, other, dense], { mainSparseId: 's2' })
    expect(out.get('c')).toBe('it was built on "Sparse cloud", not the main sparse model')
    expect(outdatedReasons([other, dense], { mainSparseId: 's2' }).get('c')).toBe(
      'the sparse model it was built on was removed',
    )
  })
})

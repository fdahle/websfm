import { describe, it, expect } from 'vitest'
import { makeView, nextViewName, normalizeSavedViews, renameView, viewName, viewStale } from './savedViews.js'

const camera = { position: [1, 2, 3], target: [0, 0, 0], up: [0, 0, 1] }

describe('saved views', () => {
  it('keeps where the camera stood, and the frame height of an orthographic one', () => {
    expect(makeView({ id: 'a', name: 'North', camera, model: { id: 's', kind: 'sparse', createdAt: 5 } })).toEqual({
      id: 'a',
      name: 'North',
      position: [1, 2, 3],
      target: [0, 0, 0],
      up: [0, 0, 1],
      ortho: false,
      model: { id: 's', createdAt: 5 },
    })
    expect(makeView({ id: 'b', name: 'Plan', camera: { ...camera, ortho: true, halfHeight: 40 } })).toMatchObject({
      ortho: true,
      halfHeight: 40,
      model: null,
    })
    expect(makeView({ id: 'c', name: 'x', camera: { ...camera, position: [1, NaN, 3] } })).toBeNull()
  })

  it('reads a saved list back, leaving out what is malformed', () => {
    const good = makeView({ id: 'a', name: 'North', camera })
    expect(normalizeSavedViews([good, { id: 'b', name: '  ' }, { id: 'c', name: 'Bad', position: 'x' }, null])).toEqual(
      [good],
    )
    expect(normalizeSavedViews(undefined)).toEqual([])
  })

  it('is out of date once its model is replaced', () => {
    const v = makeView({ id: 'a', name: 'N', camera, model: { id: 's', createdAt: 5 } })
    expect(viewStale(v, { id: 's', createdAt: 5 })).toBe(false)
    expect(viewStale(v, { id: 's', createdAt: 6 })).toBe(true)
    expect(viewStale(v, { id: 't', createdAt: 5 })).toBe(true)
    expect(viewStale(v, null)).toBe(true)
    expect(viewStale(makeView({ id: 'b', name: 'N', camera }), { id: 's' })).toBe(false)
  })

  it('names and renames views, refusing a clash or an empty name', () => {
    const views = [makeView({ id: 'a', name: 'View 1', camera }), makeView({ id: 'b', name: 'Roof', camera })]
    expect(nextViewName(views)).toBe('View 2')
    expect(viewName('  Front   door ')).toBe('Front door')
    expect(renameView(views, 'b', 'View 1')).toEqual({ error: 'taken' })
    expect(renameView(views, 'b', ' ')).toEqual({ error: 'empty' })
    expect(renameView(views, 'z', 'X')).toEqual({ error: 'missing' })
    expect(renameView(views, 'b', 'Roof east').views.map((v) => v.name)).toEqual(['View 1', 'Roof east'])
  })
})

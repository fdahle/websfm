import { expect, it, vi } from 'vitest'
import { createImageGroups } from './imageGroups.js'

function setup() {
  const images = { value: ['a', 'b', 'c', 'd'].map((id) => ({ id, groupId: null })) }
  const imageGroups = { value: [] }
  const save = vi.fn()
  const api = createImageGroups({ imageGroups, images, isPersisting: () => true, log: vi.fn(), save })
  return { images, imageGroups, save, api }
}
const groupOf = (images) => images.value.map((i) => i.groupId)

// Image Quality's "Group flagged" asks for the same named group on every click.
it('reuses an existing group of the same name instead of stacking up another', () => {
  const { images, imageGroups, api } = setup()
  const first = api.createImageGroup({ name: 'Low image quality', imageIds: ['a', 'b'] })
  const again = api.createImageGroup({ name: ' Low image quality ', imageIds: ['b', 'c'] })
  expect(again).toBe(first)
  expect(imageGroups.value).toHaveLength(1)
  // Earlier members stay; the new ones join.
  expect(groupOf(images)).toEqual([first.id, first.id, first.id, null])
})

it('still creates a distinct group for a new name, a caller-chosen id, or no name', () => {
  const { imageGroups, api } = setup()
  const a = api.createImageGroup({ name: 'North' })
  const b = api.createImageGroup({ name: 'South' })
  // The sidebar passes its own id (to start an inline rename) — never merged.
  const c = api.createImageGroup({ id: 'side-1', name: 'North' })
  const d = api.createImageGroup({})
  expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4)
  expect(c.id).toBe('side-1')
  expect(imageGroups.value.map((g) => g.name)).toEqual(['North', 'South', 'North', d.name])
  expect(api.createImageGroup({ id: 'side-1' })).toBe(null)
})

it('persists a reuse only when it actually moved an image', () => {
  const { save, api } = setup()
  api.createImageGroup({ name: 'Low image quality', imageIds: ['a'] })
  save.mockClear()
  api.createImageGroup({ name: 'Low image quality', imageIds: ['a'] })
  expect(save).not.toHaveBeenCalled()
  api.createImageGroup({ name: 'Low image quality', imageIds: ['d'] })
  expect(save).toHaveBeenCalledTimes(1)
})

import { expect, it } from 'vitest'
import { pointGroups } from './gcpGroups.js'

const points = [
  { id: 'm1', role: 'marker' },
  { id: 'c1', role: 'control' },
  { id: 'k1', role: 'check' },
  { id: 'c2' }, // no role: an older record, a control point
  { id: 'm2', role: 'marker' },
]
const ids = (r) => r.groups.map((g) => [g.role, g.items.map((p) => p.id)])

it('groups the points by role, control first, keeping their order', () => {
  const r = pointGroups(points)
  expect(ids(r)).toEqual([
    ['control', ['c1', 'c2']],
    ['check', ['k1']],
    ['marker', ['m1', 'm2']],
  ])
  expect(r.hiddenMarkers).toBe(0)
})

it('on the map leaves the markers out, which have no ground position, and counts them', () => {
  const r = pointGroups(points, { onMap: true })
  expect(ids(r)).toEqual([
    ['control', ['c1', 'c2']],
    ['check', ['k1']],
  ])
  expect(r.hiddenMarkers).toBe(2)
})

it('shows no empty group', () => {
  expect(ids(pointGroups([{ id: 'k', role: 'check' }]))).toEqual([['check', ['k']]])
  expect(pointGroups([])).toEqual({ groups: [], hiddenMarkers: 0 })
})

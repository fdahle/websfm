import { expect, it } from 'vitest'
import { rebuildPlan } from './rebuildPlan.js'

it('rebuilds nothing when nothing is outdated', () => {
  expect(rebuildPlan({ outdated: [], depthMaps: 0 })).toEqual([])
})

it('after the sparse model changed: depth maps first, then each outdated product in order', () => {
  const outdated = [{ kind: 'ortho' }, { kind: 'dem' }, { kind: 'dense' }, { kind: 'mesh' }]
  expect(rebuildPlan({ outdated, depthMaps: 0, georeferenced: true })).toEqual([
    'compute-depth',
    'dense',
    'gen-mesh',
    'gen-dem',
    'gen-ortho',
  ])
})

it('Georeference first when a georeferenced product is outdated and the fit was dropped', () => {
  const outdated = [{ kind: 'dem', georeferenced: true }]
  expect(rebuildPlan({ outdated, georeferenced: false })).toEqual(['georeference', 'gen-dem'])
  expect(rebuildPlan({ outdated, georeferenced: true })).toEqual(['gen-dem'])
  // A product in the local frame needs no georeference.
  expect(rebuildPlan({ outdated: [{ kind: 'dem' }], georeferenced: false })).toEqual(['gen-dem'])
})

it('keeps current depth maps: only a dense cloud or orthophoto without them asks for new ones', () => {
  expect(rebuildPlan({ outdated: [{ kind: 'dense' }], depthMaps: 42 })).toEqual(['dense'])
  expect(rebuildPlan({ outdated: [{ kind: 'ortho' }], depthMaps: 0 })).toEqual(['compute-depth', 'gen-ortho'])
  expect(rebuildPlan({ outdated: [{ kind: 'dem' }, { kind: 'mesh' }], depthMaps: 0 })).toEqual(['gen-mesh', 'gen-dem'])
})

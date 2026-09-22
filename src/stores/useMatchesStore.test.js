import { beforeEach, it, expect, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useProjectsStore } from './useProjectsStore.js'
import { useMatchesStore } from './useMatchesStore.js'
import * as opfs from '../utils/opfs.js'
import * as workers from '../workers/computeClient.js'

beforeEach(() => {
  vi.restoreAllMocks()
  setActivePinia(createPinia())
  const projects = useProjectsStore()
  projects.currentProjectId = 'match-test'
  projects.persistenceAvailable = true
  vi.spyOn(opfs, 'appendLog').mockResolvedValue()
})
const image = (uuid, dim = 128) => ({ uuid, name: uuid, keypoints: [{ x: 1, y: 1 }], descDim: dim })

it.each(['rejected', 'cancelled', 'missing'])('does not resurrect old matches after %s rematching', async outcome => {
  let disk = { idA: 'a', idB: 'b', rawCount: 1, inlierCount: 1, matches: [[0, 0]], F: null }
  vi.spyOn(opfs, 'deleteMatches').mockImplementation(async () => { disk = null })
  vi.spyOn(opfs, 'saveMatches').mockImplementation(async (_project, _pair, data) => { disk = data })
  vi.spyOn(opfs, 'loadDescriptors').mockResolvedValue(outcome === 'missing' ? null : new Float32Array(128))
  vi.spyOn(opfs, 'loadAllMatches').mockImplementation(async () => disk ? [{ pairId: 'a--b', ...disk }] : [])
  const match = vi.spyOn(workers, 'matchDescriptors')
  if (outcome === 'cancelled') match.mockRejectedValue(new Error('Cancelled'))
  else match.mockResolvedValue({ matches: [] })
  const store = useMatchesStore()
  await store.matchPair(image('a'), image('b'), { subsetGate: false })
  expect(disk).toBeNull()
  await store.restore({ projectId: 'match-test' })
  expect(store.getMatch('a', 'b')).toBeNull()
})

it.each(['dimensions', 'length', 'detector'])('refuses incompatible descriptor %s before dispatch', async reason => {
  vi.spyOn(opfs, 'deleteMatches').mockResolvedValue()
  vi.spyOn(opfs, 'loadDescriptors').mockResolvedValue(new Float32Array(reason === 'length' ? 127 : 128))
  const match = vi.spyOn(workers, 'matchDescriptors').mockResolvedValue({ matches: [] })
  const b = image('b', reason === 'dimensions' ? 256 : 128)
  if (reason === 'detector') b.detector = 'superpoint'
  await useMatchesStore().matchPair(image('a'), b, { subsetGate: false })
  expect(match).not.toHaveBeenCalled()
  expect(useMatchesStore().getMatch('a', 'b').status).toBe('error')
})

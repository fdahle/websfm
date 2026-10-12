import { beforeEach, it, expect, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { useProjectsStore } from './useProjectsStore.js'
import { useMatchesStore } from './useMatchesStore.js'
import * as opfs from '../utils/opfs.js'
import * as workers from '../workers/computeClient.js'
import { packMatchDocument, toMatchArray } from '../core/features/matchStorage.js'
import { keypointsFromObjects as K } from '../core/features/keypoints.js'

// Keypoints are not on the image records: the matches store asks the images store,
// which reads them from OPFS per image (useImagesStore.ensureKeypoints).
let kpFiles
beforeEach(() => {
  vi.restoreAllMocks()
  setActivePinia(createPinia())
  const projects = useProjectsStore()
  projects.currentProjectId = 'match-test'
  projects.persistenceAvailable = true
  vi.spyOn(opfs, 'appendLog').mockResolvedValue()
  kpFiles = new Map()
  vi.spyOn(opfs, 'loadKeypoints').mockImplementation(async (_p, uuid) => kpFiles.get(uuid)?.data ?? null)
  vi.spyOn(opfs, 'loadColors').mockResolvedValue(null)
})
const withKeypoints = (uuid, list, dim = 128) => {
  kpFiles.set(uuid, K(list))
  return { uuid, name: uuid, kpStatus: 'done', kpCount: list.length, descDim: dim }
}
const image = (uuid, dim = 128) => withKeypoints(uuid, [{ x: 1, y: 1 }], dim)

// A committed document as the writer leaves it: the index columns + the matches Blob.
const commit = (entries) => {
  const d = packMatchDocument(entries)
  return { meta: d.meta, buffers: { ...d.buffers, matches: new Blob(d.matchParts) } }
}
const asIndex = (disk) => ({ meta: disk.meta, buffers: disk.buffers, files: {}, matchesFile: disk.buffers.matches })
const u32 = async (blob) => [...new Uint32Array(await blob.arrayBuffer())]

it.each(['rejected', 'cancelled', 'missing'])('does not resurrect old matches after %s rematching', async outcome => {
  // The one packed match document (core/features/matchStorage.js), holding the old a–b result.
  let disk = commit(new Map([['a--b', { idA: 'a', idB: 'b', rawCount: 1, inlierCount: 1, matches: toMatchArray([[0, 0]]), F: null, status: 'done' }]]))
  vi.spyOn(opfs, 'saveMatchDocument').mockImplementation(async (_project, meta, buffers) => { disk = { meta, buffers }; return { files: {} } })
  vi.spyOn(opfs, 'loadDescriptors').mockResolvedValue(outcome === 'missing' ? null : new Float32Array(128))
  vi.spyOn(opfs, 'loadMatchIndex').mockImplementation(async () => asIndex(disk))
  const match = vi.spyOn(workers, 'matchDescriptors')
  if (outcome === 'cancelled') match.mockRejectedValue(new Error('Cancelled'))
  else match.mockResolvedValue({ matches: [] })
  const store = useMatchesStore()
  await store.matchPair(image('a'), image('b'), { subsetGate: false })
  expect(disk.meta.count).toBe(0) // the superseded pair is gone from disk at once
  await store.restore({ projectId: 'match-test' })
  expect(store.getMatch('a', 'b')).toBeNull()
})

it('posts only the putatives\' packed coordinates to verification', async () => {
  vi.spyOn(opfs, 'saveMatchDocument').mockResolvedValue({ files: {} })
  const n = 20
  const kps = (dx) => Array.from({ length: 50 }, (_, i) => ({ x: i * 10 + dx, y: i * 3, nx: 0, ny: 0 }))
  const a = withKeypoints('a', kps(0))
  const b = withKeypoints('b', kps(5))
  vi.spyOn(opfs, 'loadDescriptors').mockResolvedValue(new Float32Array(50 * 128))
  vi.spyOn(workers, 'matchDescriptors').mockResolvedValue({
    matches: Array.from({ length: n }, (_, i) => ({ ia: i, ib: 49 - i, dist: 1 })),
  })
  const verify = vi.spyOn(workers, 'verifyPointPairs').mockResolvedValue(null)
  await useMatchesStore().matchPair(a, b, { subsetGate: false })
  expect(verify).toHaveBeenCalledTimes(1)
  const [ptsA, ptsB] = verify.mock.calls[0]
  expect(ptsA).toBeInstanceOf(Float32Array)
  expect(ptsA).toHaveLength(2 * n)
  expect([ptsA[2], ptsA[3]]).toEqual([10, 3])      // a's keypoint 1
  expect([ptsB[2], ptsB[3]]).toEqual([485, 144])   // b's keypoint 48
})

it('matches in image-name order and stores the result in uuid order', async () => {
  // uuid order a < b, name order "alpha" (b) < "zeta" (a): b plays A in matching.
  vi.spyOn(opfs, 'saveMatchDocument').mockResolvedValue({ files: {} })
  const n = 20
  const kps = (dx) => Array.from({ length: 50 }, (_, i) => ({ x: i * 10 + dx, y: i * 7 % 300, nx: 0, ny: 0 }))
  const a = { ...withKeypoints('a', kps(0)), name: 'zeta.jpg' }
  const b = { ...withKeypoints('b', kps(5)), name: 'alpha.jpg' }
  // Distinguishable after RootSIFT: a's rows are e0, b's rows e1.
  const rows = (k) => Float32Array.from({ length: 50 * 128 }, (_, i) => (i % 128 === k ? 1 : 0))
  const descOf = { a: rows(0), b: rows(1) }
  vi.spyOn(opfs, 'loadDescriptors').mockImplementation(async (_p, uuid) => descOf[uuid])
  const match = vi.spyOn(workers, 'matchDescriptors').mockResolvedValue({
    matches: Array.from({ length: n }, (_, i) => ({ ia: i, ib: 49 - i, dist: 1 })),
  })
  const F = [[0, -0.3, 0.2], [0.4, 0, -1.1], [-0.25, 0.9, 0.05]]
  const verify = vi.spyOn(workers, 'verifyPointPairs').mockResolvedValue({
    F, inlierMask: new Float32Array(n).fill(1), inlierCount: n, hInlierCount: 0,
  })
  const store = useMatchesStore()
  await store.matchPair(a, b, { subsetGate: false })
  // Matching saw b first: its descriptors and keypoints in the A role.
  expect([match.mock.calls[0][0][0], match.mock.calls[0][0][1]]).toEqual([0, 1])
  expect([verify.mock.calls[0][0][2], verify.mock.calls[0][0][3]]).toEqual([15, 7]) // b's keypoint 1
  // Stored in uuid order: [a index, b index] and F for x_b·F·x_a = 0.
  const entry = store.getMatch('a', 'b')
  expect(entry.idA).toBe('a')
  expect([...store.residentPairMatches('a--b')].slice(0, 4)).toEqual([49, 0, 48, 1])
  expect(entry.F).toEqual([[0, 0.4, -0.25], [-0.3, 0, 0.9], [0.2, -1.1, 0.05]])
})

it('folds SIFT orientation siblings onto one keypoint before verification', async () => {
  vi.spyOn(opfs, 'saveMatchDocument').mockResolvedValue({ files: {} })
  // 30 features; in both images keypoint 30+i is the second-orientation sibling of i.
  const kps = (dx) => {
    const base = Array.from({ length: 30 }, (_, i) => ({ x: i * 10 + dx, y: i * 3, scale: 2, nx: 0, ny: 0 }))
    return [...base, ...base.map((k) => ({ ...k }))]
  }
  const a = withKeypoints('a', kps(0))
  const b = withKeypoints('b', kps(5))
  vi.spyOn(opfs, 'loadDescriptors').mockResolvedValue(new Float32Array(60 * 128))
  vi.spyOn(workers, 'matchDescriptors').mockResolvedValue({
    matches: [
      ...Array.from({ length: 20 }, (_, i) => ({ ia: i, ib: i, dist: 1 })),
      ...Array.from({ length: 20 }, (_, i) => ({ ia: 30 + i, ib: 30 + i, dist: 0.5 })), // same features again
      { ia: 55, ib: 25, dist: 1 }, // feature 25, matched only through its secondary orientation in A
    ],
  })
  const verify = vi.spyOn(workers, 'verifyPointPairs').mockResolvedValue(null)
  const store = useMatchesStore()
  await store.matchPair(a, b, { subsetGate: false })
  const [ptsA] = verify.mock.calls[0]
  expect(ptsA).toHaveLength(2 * 21) // 20 merged + 1 re-expressed, no duplicates
  const entry = store.getMatch('a', 'b')
  expect(entry).toMatchObject({ rawCount: 21, siblingMerged: 20, siblingAmbiguous: 0 })
})

it.each(['dimensions', 'length', 'detector'])('refuses incompatible descriptor %s before dispatch', async reason => {
  vi.spyOn(opfs, 'saveMatchDocument').mockResolvedValue({ files: {} })
  vi.spyOn(opfs, 'loadDescriptors').mockResolvedValue(new Float32Array(reason === 'length' ? 127 : 128))
  const match = vi.spyOn(workers, 'matchDescriptors').mockResolvedValue({ matches: [] })
  const b = image('b', reason === 'dimensions' ? 256 : 128)
  if (reason === 'detector') b.detector = 'superpoint'
  await useMatchesStore().matchPair(image('a'), b, { subsetGate: false })
  expect(match).not.toHaveBeenCalled()
  expect(useMatchesStore().getMatch('a', 'b').status).toBe('error')
})

it('fails a pair whose keypoint file is missing instead of matching against nothing', async () => {
  vi.spyOn(opfs, 'saveMatchDocument').mockResolvedValue({ files: {} })
  vi.spyOn(opfs, 'loadDescriptors').mockResolvedValue(new Float32Array(128))
  const match = vi.spyOn(workers, 'matchDescriptors').mockResolvedValue({ matches: [] })
  const b = image('b'); kpFiles.delete('b')
  await useMatchesStore().matchPair(image('a'), b, { subsetGate: false })
  expect(match).not.toHaveBeenCalled()
  expect(useMatchesStore().getMatch('a', 'b').status).toBe('error')
  expect(b).toMatchObject({ kpStatus: 'error', kpCount: 0 })
})

it('keeps matches as a flat Uint32Array and rewrites only the flags when a pair is excluded', async () => {
  const saves = []
  vi.spyOn(opfs, 'saveMatchDocument').mockImplementation(async (_p, meta, buffers) => {
    saves.push(buffers)
    return { files: { pairs: { name: 'p', bytes: 8 }, counts: { name: 'c', bytes: 12 }, flags: { name: 'f', bytes: 1 }, F: { name: 'F', bytes: 72 }, matches: { name: 'm', bytes: 8 } } }
  })
  vi.spyOn(opfs, 'loadMatchesFile').mockImplementation(async () => saves.at(-1).matches)
  const store = useMatchesStore()
  await store.importMatches([{ uuidA: 'b', uuidB: 'a', matches: [[5, 7]] }])
  const entry = store.getMatch('a', 'b')
  expect(entry.nMatches).toBe(1)
  expect(entry.matches).toBeUndefined() // the summary never carries the buffer
  expect([...store.residentPairMatches('a--b')]).toEqual([7, 5]) // flipped into the sorted-uuid order
  expect(saves.at(-1).matches).toBeInstanceOf(Blob)
  expect(await u32(saves.at(-1).matches)).toEqual([7, 5])
  // Committed: the pair now has a home in the document and its copy is evictable.
  expect(entry.src).toMatchObject({ off: 0 })
  expect(store.matchCacheStats().pinned).toBe(0)
  store.setPairDisabled('a--b', true)
  await new Promise((r) => setTimeout(r, 0))
  const last = saves.at(-1)
  expect(last.matches).toEqual({ reuse: { name: 'm', bytes: 8 } })
  expect([...last.flags]).toEqual([1])
})

it('opens on the index alone and reads each pair\'s matches from its byte range on demand', async () => {
  const disk = commit(new Map([
    ['a--b', { idA: 'a', idB: 'b', rawCount: 9, inlierCount: 3, F: null, matches: toMatchArray([[1, 2], [3, 4], [5, 6]]), status: 'done' }],
    ['a--c', { idA: 'a', idB: 'c', rawCount: 4, inlierCount: 1, F: null, matches: toMatchArray([[7, 8]]), status: 'done', weak: true }],
    ['b--c', { idA: 'b', idB: 'c', rawCount: 4, inlierCount: 2, F: null, matches: toMatchArray([[9, 10], [11, 12]]), status: 'done' }],
  ]))
  const blob = disk.buffers.matches
  const reads = []
  const file = { size: blob.size, slice: vi.fn((s, e) => { reads.push([s, e]); return blob.slice(s, e) }) }
  vi.spyOn(opfs, 'loadMatchIndex').mockResolvedValue({ ...asIndex(disk), matchesFile: file })
  const store = useMatchesStore()
  await store.restore({ projectId: 'match-test' })

  // Restore read nothing from the matches column; the summaries are all there.
  expect(reads).toEqual([])
  expect(store.matchStore.size).toBe(3)
  expect(store.getMatch('a', 'b')).toMatchObject({ nMatches: 3, inlierCount: 3 })
  expect(store.getMatch('a', 'c')).toMatchObject({ nMatches: 1, weak: true })
  expect(store.usableMatchCount).toBe(3)
  expect(store.residentPairMatches('a--b')).toBeNull()
  expect(store.matchCacheStats().entries).toBe(0)

  // One pair: exactly its byte range, then kept.
  expect([...await store.ensurePairMatches('a--c')]).toEqual([7, 8])
  expect(reads).toEqual([[24, 32]])
  expect([...await store.ensurePairMatches('a--c')]).toEqual([7, 8])
  expect(reads).toHaveLength(1)
  // A read-through does not displace the cache.
  expect([...await store.readPairMatches('b--c')]).toEqual([9, 10, 11, 12])
  expect(store.residentPairMatches('b--c')).toBeNull()

  // A bulk pass in document order: one read for the non-resident run.
  reads.length = 0
  const seen = []
  await store.streamPairMatches([...store.matchStore.values()], (e, m) => { seen.push([`${e.idA}--${e.idB}`, [...m]]) })
  expect(seen).toEqual([['a--b', [1, 2, 3, 4, 5, 6]], ['a--c', [7, 8]], ['b--c', [9, 10, 11, 12]]])
  expect(reads).toEqual([[0, 24], [32, 48]]) // a--c came from memory, so the run splits around it
})

it('rewrites the document from resident pairs plus slices of the previous generation', async () => {
  const disk = commit(new Map([
    ['a--b', { idA: 'a', idB: 'b', rawCount: 9, inlierCount: 3, F: null, matches: toMatchArray([[1, 2], [3, 4]]), status: 'done' }],
  ]))
  vi.spyOn(opfs, 'loadMatchIndex').mockResolvedValue(asIndex(disk))
  let saved = null
  vi.spyOn(opfs, 'saveMatchDocument').mockImplementation(async (_p, meta, buffers) => {
    saved = { meta, buffers }
    return { files: { matches: { name: 'm2', bytes: buffers.matches.size } } }
  })
  vi.spyOn(opfs, 'loadMatchesFile').mockImplementation(async () => saved.buffers.matches)
  const store = useMatchesStore()
  await store.restore({ projectId: 'match-test' })
  await store.importMatches([{ uuidA: 'a', uuidB: 'c', matches: [[5, 6]] }])
  expect(saved.meta.count).toBe(2)
  expect(await u32(saved.buffers.matches)).toEqual([1, 2, 3, 4, 5, 6])
  // Both pairs now point into the new generation; nothing is pinned any more.
  expect(store.getMatch('a', 'c').src).toMatchObject({ off: 4 })
  expect(store.matchCacheStats().pinnedBytes).toBe(0)
  expect([...await store.readPairMatches('a--b')]).toEqual([1, 2, 3, 4])
})

it('refuses an unreadable document instead of opening an empty graph silently', async () => {
  vi.spyOn(opfs, 'loadMatchIndex').mockRejectedValue(new Error('Incomplete saved buffer: counts'))
  const legacy = vi.spyOn(opfs, 'loadLegacyPairFiles').mockResolvedValue([])
  const store = useMatchesStore()
  await store.restore({ projectId: 'match-test' })
  expect(store.matchStore.size).toBe(0)
  expect(legacy).not.toHaveBeenCalled()
})

it('re-points at the copy when the file it read from went away (a storage move)', async () => {
  const disk = commit(new Map([
    ['a--b', { idA: 'a', idB: 'b', rawCount: 9, inlierCount: 2, F: null, matches: toMatchArray([[1, 2], [3, 4]]), status: 'done' }],
  ]))
  const blob = disk.buffers.matches
  const gone = { size: blob.size, slice: () => ({ arrayBuffer: () => Promise.reject(new Error('NotFoundError')) }) }
  vi.spyOn(opfs, 'loadMatchIndex').mockResolvedValue({ ...asIndex(disk), files: { matches: { name: 'm', bytes: blob.size } }, matchesFile: gone })
  const refetch = vi.spyOn(opfs, 'loadMatchesFile').mockResolvedValue(blob)
  const store = useMatchesStore()
  await store.restore({ projectId: 'match-test' })
  expect([...await store.readPairMatches('a--b')]).toEqual([1, 2, 3, 4])
  expect(refetch).toHaveBeenCalledWith('match-test', { name: 'm', bytes: blob.size })
  expect(store.getMatch('a', 'b').src.file).toBe(blob)
})

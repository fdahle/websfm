import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'

const saved = []
vi.mock('../../utils/download.js', () => ({ downloadBlob: (name, blob) => saved.push({ name, blob }) }))

const { createTabularExports } = await import('./tabular.js')

describe('exportMatches', () => {
  it('writes the pairs the project keeps, not the rejected ones', async () => {
    const entries = [
      { idA: 'a', idB: 'b', status: 'done', nMatches: 2, rawCount: 9, inlierCount: 2, m: new Uint32Array([0, 1, 2, 3]) },
      // Rejected: verified, no inliers, never saved — gone after a reopen.
      { idA: 'a', idB: 'c', status: 'done', nMatches: 0, rawCount: 7, inlierCount: 0, m: new Uint32Array() },
      { idA: 'b', idB: 'c', status: 'pending' },
    ]
    const matchStore = ref(new Map(entries.map((e) => [`${e.idA}--${e.idB}`, e])))
    const matchesStore = { streamPairMatches: async (list, onPair) => { for (const e of list) onPair(e, e.m) } }
    const images = ref([{ uuid: 'a', name: 'A.jpg' }, { uuid: 'b', name: 'B.jpg' }, { uuid: 'c', name: 'C.jpg' }])
    const ex = createTabularExports({ images, matchStore, matchesStore, log: () => {} })
    await ex.exportMatches()
    const out = JSON.parse(await saved.at(-1).blob.text())
    expect(out).toEqual([{ imageA: 'A.jpg', imageB: 'B.jpg', rawCount: 9, inlierCount: 2, matches: [[0, 1], [2, 3]] }])
  })
})

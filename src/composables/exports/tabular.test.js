import { describe, it, expect, vi } from 'vitest'
import { ref } from 'vue'

const saved = []
vi.mock('../../utils/download.js', () => ({ downloadBlob: (name, blob) => saved.push({ name, blob }) }))

const { createTabularExports } = await import('./tabular.js')

describe('doExportMatches', () => {
  it('writes the pairs the project keeps, not the rejected ones', async () => {
    const entries = [
      {
        idA: 'a',
        idB: 'b',
        status: 'done',
        nMatches: 2,
        rawCount: 9,
        inlierCount: 2,
        m: new Uint32Array([0, 1, 2, 3]),
      },
      // Rejected: verified, no inliers, never saved — gone after a reopen.
      { idA: 'a', idB: 'c', status: 'done', nMatches: 0, rawCount: 7, inlierCount: 0, m: new Uint32Array() },
      { idA: 'b', idB: 'c', status: 'pending' },
    ]
    const matchStore = ref(new Map(entries.map((e) => [`${e.idA}--${e.idB}`, e])))
    const matchesStore = {
      streamPairMatches: async (list, onPair) => {
        for (const e of list) onPair(e, e.m)
      },
    }
    const images = ref([
      { uuid: 'a', name: 'A.jpg' },
      { uuid: 'b', name: 'B.jpg' },
      { uuid: 'c', name: 'C.jpg' },
    ])
    const ex = createTabularExports({ images, matchStore, matchesStore, log: () => {}, projectBase: () => 'site' })
    await ex.doExportMatches({ format: 'json' })
    expect(saved.at(-1).name).toBe('site-matches.json')
    const out = JSON.parse(await saved.at(-1).blob.text())
    expect(out).toEqual([
      {
        imageA: 'A.jpg',
        imageB: 'B.jpg',
        rawCount: 9,
        inlierCount: 2,
        matches: [
          [0, 1],
          [2, 3],
        ],
      },
    ])

    await ex.doExportMatches({ format: 'csv' })
    expect(saved.at(-1).name).toBe('site-matches.csv')
    expect(await saved.at(-1).blob.text()).toBe(
      'image_a,image_b,index_a,index_b\r\nA.jpg,B.jpg,0,1\r\nA.jpg,B.jpg,2,3\r\n',
    )

    await ex.doExportMatches({ format: 'csv', content: 'pairs', fileName: 'my pairs' })
    expect(saved.at(-1).name).toBe('my_pairs.csv')
    expect(await saved.at(-1).blob.text()).toBe('image_a,image_b,raw_count,inlier_count\r\nA.jpg,B.jpg,9,2\r\n')
  })
})

// What Export ▸ Keypoints and Export ▸ Matches write, Import ▸ Keypoints / Matches reads
// back (core/io/featureText.js), in either format: the same images, positions and pairs.
describe('keypoints and matches read back', async () => {
  const { readFeatureFile } = await import('../../core/io/featureText.js')
  // Values a Float32Array holds exactly, so the comparison needs no tolerance.
  const kps = {
    a: { x: [10.5, 200.25, 0], y: [20.75, 3, 479.5], scale: [1.5, 2, 6.25], response: [0.01, 0.5, 0.25] },
    b: { x: [5, 6.5], y: [7, 8.25], scale: [3, 4], response: [0.1, 0.2] },
  }
  const images = ref([
    { uuid: 'a', name: 'IMG 1.jpg', kpStatus: 'done', kpCount: 3 },
    { uuid: 'b', name: 'B,2.jpg', kpStatus: 'done', kpCount: 2 },
  ])
  const imagesStore = {
    readKeypoints: async (img) => {
      const k = kps[img.uuid]
      return {
        length: k.x.length,
        x: (i) => k.x[i],
        y: (i) => k.y[i],
        scale: (i) => k.scale[i],
        response: (i) => k.response[i],
      }
    },
  }
  const pair = { idA: 'a', idB: 'b', status: 'done', nMatches: 2, rawCount: 5, inlierCount: 2 }
  const m = new Uint32Array([0, 1, 2, 0])
  const matchStore = ref(new Map([['a--b', pair]]))
  const matchesStore = { streamPairMatches: async (list, onPair) => list.forEach((e) => onPair(e, m)) }
  const ex = createTabularExports({
    images,
    imagesStore,
    matchStore,
    matchesStore,
    log: () => {},
    projectBase: () => 'site',
  })
  const read = async () => readFeatureFile(await saved.at(-1).blob.text(), saved.at(-1).name)

  for (const format of ['json', 'csv']) {
    it(`keypoints as ${format}`, async () => {
      await ex.doExportKeypoints({ format })
      const r = await read()
      expect(r.kind).toBe('keypoints')
      expect(
        r.images.map((im) => ({ name: im.name, x: [...im.x], y: [...im.y], scale: [...im.scale], angle: im.angle })),
      ).toEqual([
        { name: 'IMG 1.jpg', x: kps.a.x, y: kps.a.y, scale: kps.a.scale, angle: null },
        { name: 'B,2.jpg', x: kps.b.x, y: kps.b.y, scale: kps.b.scale, angle: null },
      ])
    })

    it(`matches as ${format}`, async () => {
      await ex.doExportMatches({ format })
      const r = await read()
      expect(r.kind).toBe('matches')
      expect(r.pairs.map((p) => ({ a: p.a, b: p.b, idx: [...p.idx] }))).toEqual([
        { a: 'IMG 1.jpg', b: 'B,2.jpg', idx: [...m] },
      ])
    })
  }

  it('says the pair list alone holds no matches to import', async () => {
    await ex.doExportMatches({ format: 'json', content: 'pairs' })
    await expect(read()).rejects.toThrow(/without their matches/)
  })
})

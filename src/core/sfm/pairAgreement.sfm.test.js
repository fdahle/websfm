// The pair check end to end: the real reconstruct() and wasm on a synthetic aerial
// block (pairAgreement.test.js tests the rules alone).
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { beforeAll, describe, it, expect } from 'vitest'

import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { reconstruct } from './sfm.js'
import { aerialBlock, mulberry32 } from './syntheticScene.testutil.js'
import { packMatchPairs, Uint32PairList } from './matchCodec.js'
import { PAIR_AGREES, PAIR_CONFLICTS, SUSPECT_NONE } from './pairAgreement.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

const block = () => aerialBlock({ seed: 21, rows: 3, cols: 6, calibrated: true, prefix: 'pc' })
const run = async (scene) => {
  const logs = []
  const out = await reconstruct(
    { images: scene.images, pairs: scene.pairs, gcps: [], cameraPriors: [] },
    { onLog: (m, level) => logs.push([level, m]) },
  )
  return { out, logs }
}
const pairIndex = (pc, a, b) => {
  for (let i = 0; i < pc.status.length; i++) {
    const [u, v] = [pc.uuids[pc.a[i]], pc.uuids[pc.b[i]]]
    if ((u === a && v === b) || (u === b && v === a)) return i
  }
  return -1
}

describe('pair check on a reconstructed block', () => {
  it('a clean block: every scored pair agrees and nothing is suspect', async () => {
    const scene = block()
    const { out, logs } = await run(scene)
    expect(out.status).toBe('done')
    const pc = out.pairCheck
    expect(out.pairScores).toBeUndefined() // finished into the columns
    expect(pc.status.length).toBeGreaterThan(scene.pairs.length * 0.9)
    expect([...pc.status].every((s) => s === PAIR_AGREES)).toBe(true)
    expect([...pc.suspect].every((s) => s === SUSPECT_NONE)).toBe(true)
    expect(out.summary.pairCheck).toMatchObject({ conflicts: 0, holds: 0, contradicts: 0 })
    expect(
      logs.some(([l, m]) => l === 'info' && m.startsWith('Pair check: ') && m.includes(' agree, 0 disagree')),
    ).toBe(true)
    expect(logs.some(([l, m]) => l === 'warn' && m.includes('false match'))).toBe(false)
  }, 120_000)

  it('a planted false pair between photos that do not overlap is flagged; no true pair is', async () => {
    const scene = block()
    const paired = new Set(scene.pairs.map((p) => `${p.idA}|${p.idB}`))
    // Opposite corners of the block: no shared ground, so never paired by the scene.
    const A = scene.images[0],
      B = scene.images[scene.images.length - 1]
    expect(paired.has(`${A.uuid}|${B.uuid}`)).toBe(false)
    const rng = mulberry32(5)
    const used = [new Set(), new Set()]
    const list = []
    while (list.length < 80) {
      const ia = Math.floor(rng() * A.keypoints.length),
        ib = Math.floor(rng() * B.keypoints.length)
      if (used[0].has(ia) || used[1].has(ib)) continue
      used[0].add(ia)
      used[1].add(ib)
      list.push([ia, ib])
    }
    const near = scene.pairs.find((p) => p.idA === A.uuid)
    scene.pairs.push({
      idA: A.uuid,
      idB: B.uuid,
      F: near.F, // some plausible F; the matches fit none
      matches: new Uint32PairList(packMatchPairs(list)),
      inlierCount: list.length,
      weak: false,
      status: 'done',
    })
    const { out } = await run(scene)
    expect(out.status).toBe('done')
    const pc = out.pairCheck
    const i = pairIndex(pc, A.uuid, B.uuid)
    expect(i).toBeGreaterThanOrEqual(0)
    expect(pc.status[i]).toBe(PAIR_CONFLICTS)
    expect(pc.suspect[i]).not.toBe(SUSPECT_NONE)
    for (let k = 0; k < pc.status.length; k++) if (k !== i) expect(pc.suspect[k]).toBe(SUSPECT_NONE)
  }, 120_000)
})

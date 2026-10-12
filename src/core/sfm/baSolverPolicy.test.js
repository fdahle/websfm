import { describe, it, expect, beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { reconstruct } from './sfm.js'
import { aerialBlock } from './syntheticScene.testutil.js'
import { SFM_TUNING } from '../tuning.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

describe('bundle-adjustment solver policy', () => {
  // A partial override replaced the whole policy and dropped functionTolerance, so
  // an overnight solver sweep measured LM running to its iteration cap instead.
  it('merges a partial override over the tuned defaults, key by key', async () => {
    const scene = aerialBlock({ seed: 5, rows: 3, cols: 3, nPoints: 600, calibrated: true, prefix: 'p' })
    const out = await reconstruct({ images: scene.images, pairs: scene.pairs,
      settings: { ...(scene.settings ?? {}), baSolver: { pcgRelTol: 1e-6 } } }, { onLog: () => {} })
    const policy = out.summary.baSolver.policy
    expect(policy.pcgRelTol).toBe(1e-6)
    expect(policy.functionTolerance).toBe(SFM_TUNING.baSolver.functionTolerance)
  }, 120_000)
})

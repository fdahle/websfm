import { describe, it, expect, beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { reconstruct } from './sfm.js'
import { aerialBlock } from './syntheticScene.testutil.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

const run = async (settings) => {
  const scene = aerialBlock({ seed: 11, rows: 4, cols: 6, nPoints: 2500, calibrated: true, prefix: 'l' })
  const logs = []
  const out = await reconstruct({ images: scene.images, pairs: scene.pairs, settings: { ...(scene.settings ?? {}), ...settings } },
    { onLog: (m) => logs.push(m) })
  return { out, logs }
}

describe('local bundle adjustment (localBaWindow)', () => {
  it('refines each new camera\'s window with its neighbours fixed and keeps the model', async () => {
    const base = await run({})
    const local = await run({ localBaWindow: 8, interimBaGrowth: 2 })
    expect(local.logs.some((m) => /^local BA \(.*free \+ \d+ fixed cameras/.test(m))).toBe(true)
    expect(base.logs.some((m) => m.startsWith('local BA ('))).toBe(false)
    expect(local.out.summary.nCameras).toBe(base.out.summary.nCameras)
    // Same final quality within a small margin: the global solves still run at the end.
    expect(local.out.summary.postBaMedianPx).toBeGreaterThan(0)
    expect(local.out.summary.postBaMedianPx).toBeLessThan(base.out.summary.postBaMedianPx * 1.15 + 0.05)
  }, 300_000)
})

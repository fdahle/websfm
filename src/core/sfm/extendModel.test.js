import { describe, it, expect, beforeAll } from 'vitest'
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import initRecon from '../../wasm/reconstruction/reconstruction.js'
import { reconstruct } from './sfm.js'
import { aerialBlock } from './syntheticScene.testutil.js'
import { packReconstructionResult, unpackReconstructionResult } from './resultCodec.js'
import { cameraCenter } from './geometry.js'
import { fitSimilarity, applySimilarity } from '../products/georef.js'
import { extensionBlocker, resolveExistingCameras } from './extendModel.js'

beforeAll(async () => {
  const wasmUrl = new URL('../../wasm/reconstruction/reconstruction_bg.wasm', import.meta.url)
  await initRecon({ module_or_path: await readFile(fileURLToPath(wasmUrl)) })
})

const COLS = 6
// The model as the store keeps it: through the worker's transport codec, so the points
// are a SparsePoints with their BA-frame pixels.
const asSaved = (result) => {
  const m = unpackReconstructionResult(packReconstructionResult(result).result)
  return { cameras: m.cameras, points: m.points, summary: result.summary }
}
// Camera centre error against the truth, in units of the camera spacing, after the best
// similarity from the solved frame to the true one (fitted on `fitOn` cameras).
function centreErrors(cameras, truth, fitOn) {
  const byUuid = new Map(truth.cams.map((c) => [c.uuid, c.C]))
  const centre = (u) => cameraCenter(cameras.get(u))
  const sim = fitSimilarity(fitOn.map((u) => ({ src: centre(u), dst: byUuid.get(u) })))
  const spacing = Math.hypot(...truth.cams[1].C.map((v, i) => v - truth.cams[0].C[i]))
  return (uuids) =>
    uuids.map((u) => {
      const p = applySimilarity(sim, centre(u))
      return Math.hypot(...p.map((v, i) => v - byUuid.get(u)[i])) / spacing
    })
}
const camMap = (out) => new Map(out.cameras.map(({ uuid, ...c }) => [uuid, c]))

async function scenario(sceneOpts) {
  const scene = aerialBlock({ seed: 23, rows: 4, cols: COLS, nPoints: 2500, ...sceneOpts })
  const oldIds = new Set(scene.images.filter((_, i) => i % COLS < 4).map((im) => im.uuid))
  const settings = { ...(scene.settings ?? {}), secondaryModels: false }
  const baseOut = await reconstruct({
    images: scene.images.filter((im) => oldIds.has(im.uuid)),
    pairs: scene.pairs.filter((p) => oldIds.has(p.idA) && oldIds.has(p.idB)),
    settings,
  })
  expect(baseOut.status).toBe('done')
  const base = asSaved(baseOut)
  const logs = []
  const out = await reconstruct(
    { images: scene.images, pairs: scene.pairs, settings, base },
    { onLog: (m, level) => logs.push([m, level]) },
  )
  return { scene, oldIds, base, out, logs, settings }
}

describe('extendModel: adding images to a saved model', () => {
  for (const [name, opts] of [
    ['a calibrated camera', { calibrated: true }],
    ['a self-calibrated camera', {}],
  ]) {
    it(`registers the new images and leaves the model's cameras where they were (${name})`, async () => {
      const { scene, oldIds, base, out, logs, settings } = await scenario(opts)
      expect(out.status).toBe('done')
      const cams = camMap(out)
      const newIds = scene.images.map((im) => im.uuid).filter((u) => !oldIds.has(u))
      expect(newIds.every((u) => cams.has(u))).toBe(true)
      expect(out.summary.extension).toMatchObject({ modelCameras: base.cameras.size, added: newIds.length })
      expect(out.summary.extension.notAdded).toEqual([])
      // Fixed means fixed: the old cameras are bit-identical.
      for (const [u, c] of base.cameras) {
        expect(cams.get(u).R).toEqual(c.R)
        expect(cams.get(u).t).toEqual(c.t)
        expect(cams.get(u).K).toEqual(c.K)
      }
      // The model's frame was rebuilt from the detected keypoints (extendModel.js).
      const frameLine = logs.find(([m]) => m.startsWith('model frame rebuilt'))?.[0]
      expect(frameLine).toBeTruthy()
      expect(out.summary.extension.frame.medianPx).toBeLessThan(0.01)
      expect(out.summary.selfCalDistortion).toEqual(base.summary.selfCalDistortion)

      // The new cameras sit about as close to the truth as a run of every image puts them.
      const full = await reconstruct({ images: scene.images, pairs: scene.pairs, settings })
      const fullCams = camMap(full)
      const ext = centreErrors(cams, scene.truth, [...oldIds])(newIds)
      const ref = centreErrors(fullCams, scene.truth, [...fullCams.keys()])(newIds)
      const median = (a) => [...a].sort((x, y) => x - y)[a.length >> 1]
      expect(median(ext)).toBeLessThan(Math.max(0.02, 3 * median(ref)))
      expect(out.summary.postBaMedianPx).toBeLessThan(full.summary.postBaMedianPx * 1.5 + 0.1)
    }, 600_000)
  }

  it('stops when the old images were detected again since the model was built', async () => {
    const scene = aerialBlock({ seed: 23, rows: 3, cols: 4, nPoints: 1500, calibrated: true })
    const oldIds = new Set(scene.images.filter((_, i) => i % 4 < 3).map((im) => im.uuid))
    const settings = { secondaryModels: false }
    const baseOut = await reconstruct({
      images: scene.images.filter((im) => oldIds.has(im.uuid)),
      pairs: scene.pairs.filter((p) => oldIds.has(p.idA) && oldIds.has(p.idB)),
      settings,
    })
    expect(baseOut.status).toBe('done')
    // Every old image's keypoints in a new order, as a fresh detection would number them.
    const images = scene.images.map((im) => {
      if (!oldIds.has(im.uuid)) return im
      const kps = [...im.keypoints].reverse()
      return { ...im, keypoints: kps }
    })
    const out = await reconstruct({ images, pairs: scene.pairs, settings, base: asSaved(baseOut) })
    expect(out.status).toBe('error')
    expect(out.reason).toMatch(/no longer match the model/)
  }, 300_000)
})

describe('extensionBlocker and resolveExistingCameras', () => {
  const model = { cameras: new Map([['a', {}]]), points: { hasPixels: true } }
  it('names what stops an extension', () => {
    expect(extensionBlocker(null, 3)).toMatch(/no sparse model/)
    expect(extensionBlocker({ ...model, imported: true }, 3)).toMatch(/imported/)
    expect(extensionBlocker({ ...model, points: { hasPixels: false } }, 3)).toMatch(/no image observations/)
    expect(extensionBlocker(model, 0)).toMatch(/already in the model/)
    expect(extensionBlocker(model, 3)).toBe(null)
  })
  it('keeps the cameras fixed under products, and refines them without', () => {
    expect(resolveExistingCameras('auto', { hasProducts: true })).toBe('fixed')
    expect(resolveExistingCameras('auto', { hasProducts: false })).toBe('refined')
    expect(resolveExistingCameras('fixed', { hasProducts: false })).toBe('fixed')
    expect(resolveExistingCameras('refined', { hasProducts: true })).toBe('refined')
  })
})

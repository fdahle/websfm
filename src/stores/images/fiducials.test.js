import { beforeEach, expect, it, vi } from 'vitest'
import { createImageFiducials } from './fiducials.js'
import { detectFiducialSpots, prepareFiducialTemplates } from '../../workers/computeClient.js'
import { buildBorderMask } from '../../core/mask.js'

// The detector and the mask raster are faked; consensus and the commit are real.
// POOL_SIZE 1 keeps the run serial, so "cancelled after image N" is deterministic.
vi.mock('../../workers/computeClient.js', () => ({
  POOL_SIZE: 1,
  detectFiducialSpots: vi.fn(),
  prepareFiducialTemplates: vi.fn(),
  detectFiducials: vi.fn(),
}))
vi.mock('../../core/mask.js', () => ({ buildBorderMask: vi.fn() }))

const SENSOR = { id: 's1' }
const spot = () => ({
  accepted: [{ slot: 'corner-tl', px: 10, py: 12, family: 'generic', source: 'shape', confidence: 0.9 }],
  drafts: [{ slot: 'corner-br', px: 90, py: 88, family: 'generic', confidence: 0.3, reason: 'weak-peak' }],
  requested: 1, frame: { left: 2, top: 2, right: 97, bottom: 97, confidence: 0.5 },
  natW: 100, natH: 100, ms: 1,
})

function setup(n = 3) {
  const images = { value: Array.from({ length: n }, (_, i) => ({
    id: `i${i}`, name: `${i}.tif`, url: `blob:${i}`, sensorId: SENSOR.id, meta: { width: 100, height: 100 },
  })) }
  const deps = {
    images,
    imageById: (id) => images.value.find((img) => img.id === id),
    isPersisting: () => true,
    log: vi.fn(),
    save: vi.fn(),
    updateMask: vi.fn(),
    whenComputeReady: vi.fn(async () => {}),
  }
  return { images, deps, api: createImageFiducials(deps) }
}

beforeEach(() => {
  vi.resetAllMocks()
  detectFiducialSpots.mockImplementation(async () => spot())
  prepareFiducialTemplates.mockResolvedValue({ templates: [] })
  buildBorderMask.mockImplementation(async () => new Blob(['mask']))
})

it('stores detections and masks and saves when the run is not cancelled', async () => {
  const { images, deps, api } = setup()
  const out = await api.detectFiducialsForSensor({ sensor: SENSOR, settings: { generateMasks: true }, shouldCancel: () => false })
  expect(out.cancelled).toBeUndefined()
  expect(out.applied).toBe(3)
  expect(out.masksGenerated).toBe(3)
  expect(out.drafts).toHaveLength(3)
  expect(images.value.every((img) => img.fiducialDetections?.length === 1)).toBe(true)
  expect(deps.updateMask).toHaveBeenCalledTimes(3)
  expect(deps.save).toHaveBeenCalled()
})

it('starts no further image and writes nothing once cancelled between images', async () => {
  const { images, deps, api } = setup(4)
  let cancel = false
  const onProgress = vi.fn((done) => { if (done === 1) cancel = true })
  const out = await api.detectFiducialsForSensor({
    sensor: SENSOR, settings: { generateMasks: true }, onProgress, shouldCancel: () => cancel,
  })
  expect(out).toMatchObject({ cancelled: true, perImage: [], drafts: [], applied: 0, masksGenerated: 0 })
  expect(detectFiducialSpots).toHaveBeenCalledTimes(1)
  expect(onProgress).toHaveBeenCalledTimes(1)
  expect(images.value.some((img) => img.fiducialDetections?.length)).toBe(false)
  expect(deps.updateMask).not.toHaveBeenCalled()
  expect(deps.save).not.toHaveBeenCalled()
})

it('discards the result of an image that was in flight when the cancel came', async () => {
  const { images, deps, api } = setup(2)
  let cancel = false
  detectFiducialSpots.mockImplementation(async () => { cancel = true; return spot() })
  const onProgress = vi.fn()
  const out = await api.detectFiducialsForSensor({ sensor: SENSOR, onProgress, shouldCancel: () => cancel })
  expect(out.cancelled).toBe(true)
  // Not counted as done, and no next image pulled.
  expect(onProgress).not.toHaveBeenCalled()
  expect(detectFiducialSpots).toHaveBeenCalledTimes(1)
  expect(images.value.some((img) => img.fiducialDetections?.length)).toBe(false)
  expect(deps.save).not.toHaveBeenCalled()
})

// The masks are built before the commit, so a cancel while they are being built
// must not leave some images with new masks or detections.
it('writes nothing when cancelled while the frame masks are being built', async () => {
  const { images, deps, api } = setup(3)
  let cancel = false
  buildBorderMask.mockImplementation(async () => { cancel = true; return new Blob(['mask']) })
  const out = await api.detectFiducialsForSensor({ sensor: SENSOR, settings: { generateMasks: true }, shouldCancel: () => cancel })
  expect(out.cancelled).toBe(true)
  expect(buildBorderMask).toHaveBeenCalledTimes(1)
  expect(deps.updateMask).not.toHaveBeenCalled()
  expect(images.value.some((img) => img.fiducialDetections?.length)).toBe(false)
  expect(deps.save).not.toHaveBeenCalled()
})

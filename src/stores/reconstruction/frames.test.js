import { it, expect, vi } from 'vitest'
import { ref } from 'vue'
import proj4 from 'proj4'
import { createFrameResolver } from './frames.js'
import { frameFromSimilarity } from '../../core/products/georef.js'

it('keeps native foot coordinates while resolving physical scale in metres', async () => {
  proj4.defs('TEST:feet', '+proj=utm +zone=32 +datum=WGS84 +units=us-ft')
  const g = { crs: 'TEST:feet', sim: { scale: 10, R: [[1,0,0],[0,1,0],[0,0,1]], t: [0,0,0] } }
  const validGeoref = ref(g)
  const resolver = createFrameResolver({ mainSparseCloud: ref({ id: 'c', createdAt: 1 }), validGeoref,
    currentCrs: () => 'TEST:feet', georeference: vi.fn(), scaleFit: ref(null), scaleFitStatus: () => ({ valid: false }), log: vi.fn() })
  const resolved = await resolver.effectiveFrameSpec()
  expect(resolved.unit).toBe('US-ft')
  expect(resolved.scale).toBeCloseTo(10 * 1200 / 3937, 12)
  const spec = resolved.frameSpec
  const frame = frameFromSimilarity(spec, spec.crs, spec)
  expect(frame.fromSfm([1,0,0])).toEqual([10,0,0])
  expect(frame.unit).toBe('US-ft')
  const local = await resolver.effectiveFrameSpec({ crs: 'local' })
  expect(local.unit).toBe('m')
  expect(local.frameSpec.scale).toBeCloseTo(resolved.scale)
  const product = { frameStamp: resolver.frameStampOf(resolved) }
  expect(resolver.productFrameStatus(product).stale).toBe(false)
  validGeoref.value = null
  expect(resolver.productFrameStatus(product).stale).toBe(true)
})

it('puts a user orientation on the local frame, and lets a georeference outrank it', async () => {
  const basis = { origin: [1, 2, 3], east: [1, 0, 0], north: [0, 0, -1], up: [0, 1, 0] }
  const validGeoref = ref(null)
  const resolver = createFrameResolver({ mainSparseCloud: ref({ id: 'c', createdAt: 1 }), validGeoref,
    currentCrs: () => 'EPSG:32632', georeference: vi.fn(), scaleFit: ref(null), scaleFitStatus: () => ({ valid: false }),
    log: vi.fn(), orientationBasis: () => basis })
  const local = await resolver.effectiveFrameSpec()
  expect(local.frameSpec).toMatchObject({ kind: 'local', ...basis })
  expect(resolver.currentFrameSignature.value.frameKey).toContain('"up":[0,1,0]')
  validGeoref.value = { crs: 'EPSG:32632', sim: { scale: 1, R: [[1, 0, 0], [0, 1, 0], [0, 0, 1]], t: [0, 0, 0] } }
  proj4.defs('EPSG:32632', '+proj=utm +zone=32 +datum=WGS84 +units=m +no_defs')
  const geo = await resolver.effectiveFrameSpec()
  expect(geo.frameSpec.kind).toBe('similarity')
  expect(geo.frameSpec.east).toBeUndefined()
})

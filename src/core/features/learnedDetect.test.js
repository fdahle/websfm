import { it, expect } from 'vitest'
import { parseDetections, rgbaToPlanar } from './learnedDetect.js'
import { LEARNED_DETECTORS } from './learnedDetectors.js'

const t = (data, dims) => ({ data, dims })

it('parses DISK-shaped outputs (int64 xy, [1,N,128]) best-first and capped', () => {
  const n = 3, dim = 128
  const desc = new Float32Array(n * dim)
  for (let i = 0; i < n; i++) desc.fill(i + 1, i * dim, (i + 1) * dim)
  const results = {
    keypoints: t(BigInt64Array.from([1n, 2n, 3n, 4n, 5n, 6n]), [1, n, 2]),
    scores: t(Float32Array.from([0.1, 0.9, 0.5]), [1, n]),
    descriptors: t(desc, [1, n, dim]),
  }
  const out = parseDetections(results, ['keypoints', 'scores', 'descriptors'], LEARNED_DETECTORS.disk, 2)
  expect(out.dim).toBe(128)
  expect(out.keypoints).toEqual([{ x: 3, y: 4, score: expect.closeTo(0.9) }, { x: 5, y: 6, score: expect.closeTo(0.5) }])
  expect(out.descriptors[0]).toBe(2)
  expect(out.descriptors[dim]).toBe(3)
})

it('reads channels-first [1,D,N] descriptors', () => {
  const n = 2, dim = 256
  const desc = new Float32Array(n * dim)
  for (let d = 0; d < dim; d++) { desc[d * n] = 10; desc[d * n + 1] = 20 }
  const results = {
    k: t(Float32Array.from([0, 0, 1, 1]), [1, n, 2]),
    d: t(desc, [1, dim, n]),
  }
  const out = parseDetections(results, ['k', 'd'], LEARNED_DETECTORS.superpoint, 0)
  expect(out.descriptors[0]).toBe(10)
  expect(out.descriptors[dim]).toBe(20)
})

it('fails loudly when the descriptor width does not match the detector', () => {
  const results = { k: t(Float32Array.from([0, 0]), [1, 1, 2]), d: t(new Float32Array(256), [1, 1, 256]) }
  expect(() => parseDetections(results, ['k', 'd'], LEARNED_DETECTORS.disk, 0)).toThrow(/128-d/)
})

it('builds planar luma or RGB input from RGBA', () => {
  const rgba = Uint8ClampedArray.from([255, 0, 0, 255, 0, 255, 0, 255])
  expect(Array.from(rgbaToPlanar(rgba, 2, 1, 3))).toEqual([1, 0, 0, 1, 0, 0])
  const gray = rgbaToPlanar(rgba, 2, 1, 1)
  expect(gray[0]).toBeCloseTo(0.299)
  expect(gray[1]).toBeCloseTo(0.587)
})

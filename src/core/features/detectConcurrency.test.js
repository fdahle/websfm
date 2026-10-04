import { describe, expect, it } from 'vitest'
import { detectionConcurrency, fiducialDetectionConcurrency } from './detectConcurrency.js'
const images = (size, n = 10) => Array.from({ length: n }, () => ({ meta: { width: size, height: size } }))
it('bounds SIFT concurrency by the pool, image count and estimated decode/pyramid memory', () => {
  expect(detectionConcurrency(images(1200), { maxDim: 1200 }, 8)).toBe(4)
  expect(detectionConcurrency(images(1200), { maxDim: 1200 }, 2)).toBe(2)
  expect(detectionConcurrency(images(1200, 1), {}, 8)).toBe(1)
  expect(detectionConcurrency(images(10000), { maxDim: 5000 }, 8)).toBe(1)
  expect(detectionConcurrency([{}], {}, 8)).toBe(1)
  expect(detectionConcurrency(images(1200), { detector: 'superpoint' }, 8)).toBe(1)
})

describe('fiducialDetectionConcurrency', () => {
  const img = (w, h) => ({ meta: { width: w, height: h } })
  it('runs full-resolution film scans one at a time', () => {
    expect(fiducialDetectionConcurrency([img(11000, 8800), img(11000, 8800)], 8, 8)).toBe(1)
  })
  it('lets small scans share the pool, capped at four', () => {
    expect(fiducialDetectionConcurrency(Array.from({ length: 10 }, () => img(3000, 2400)), 8, 8)).toBe(4)
  })
  it('stays serial when any size is unknown', () => {
    expect(fiducialDetectionConcurrency([img(3000, 2400), { meta: {} }], 8, 8)).toBe(1)
  })
})

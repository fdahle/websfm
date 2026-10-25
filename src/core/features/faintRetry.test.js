import { describe, expect, it } from 'vitest'
import { faintRetry } from './faintRetry.js'

describe('faintRetry', () => {
  it('retries an image under half the cap at half the contrast', () => {
    expect(faintRetry(1240, { contrastThreshold: 0.01, maxKeypoints: 10000, enabled: true })).toEqual({
      contrast: 0.005,
      floor: 5000,
    })
  })
  it('keeps an image that reaches the floor', () => {
    expect(faintRetry(5000, { contrastThreshold: 0.01, maxKeypoints: 10000, enabled: true })).toBeNull()
  })
  it('follows the preset: the cap sets the floor, the threshold the retry', () => {
    expect(faintRetry(2000, { contrastThreshold: 0.02, maxKeypoints: 5000, enabled: true })).toEqual({
      contrast: 0.01,
      floor: 2500,
    })
  })
  it('does nothing when off or without a cap', () => {
    expect(faintRetry(10, { contrastThreshold: 0.01, maxKeypoints: 10000, enabled: false })).toBeNull()
    expect(faintRetry(10, { contrastThreshold: 0.01, maxKeypoints: 0, enabled: true })).toBeNull()
  })
})

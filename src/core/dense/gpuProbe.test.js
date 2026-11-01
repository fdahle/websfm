import { describe, expect, it } from 'vitest'
import { probeGivesUp } from './gpuProbe.js'

describe('probeGivesUp', () => {
  it('gives up when the CPU is on course to take far longer than the GPU', () => {
    // Melville at High: the GPU map 94 s, the CPU's coarsest level 70 s at 1.5 % done.
    expect(probeGivesUp(70_000, 0.015, 94_000)).toBe(true)
  })
  it('gives up once the CPU has taken as long as the GPU for the whole map', () => {
    expect(probeGivesUp(10_000, 0.9, 9_000)).toBe(true)
  })
  it('lets a CPU map that may win go on', () => {
    // 30 s at a quarter done: on course for 120 s against the GPU's 100 s, within 2×.
    expect(probeGivesUp(30_000, 0.25, 100_000)).toBe(false)
    expect(probeGivesUp(30_000, 0.25, 100_000, 1)).toBe(true)
  })
  it('finishes a map whose levels are all done, and needs a GPU time', () => {
    expect(probeGivesUp(500_000, 1, 94_000)).toBe(false)
    expect(probeGivesUp(500_000, 0.5, 0)).toBe(false)
  })
})

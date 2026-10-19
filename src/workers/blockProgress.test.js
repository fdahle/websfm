import { describe, expect, it } from 'vitest'
import { createBlockProgress } from './blockProgress.js'

describe('createBlockProgress', () => {
  it('logs the first block, then at most once per interval, never the last', () => {
    let t = 0
    const p = createBlockProgress(5, { prefix: 'Ortho: ', everyMs: 30_000, now: () => t })
    expect(p.label()).toBe('block 1 of 5')
    t = 110_000
    expect(p.finished()).toBe('Ortho: 1 of 5 blocks done (20 %) in 1:50, 110 s per block, about 7 minutes left')
    expect(p.label()).toBe('block 2 of 5')
    t = 120_000
    expect(p.finished()).toBeNull()
    t = 150_000
    expect(p.finished()).toMatch(/^Ortho: 3 of 5 blocks done \(60 %\) in 2:30, 50 s per block/)
    t = 400_000
    expect(p.finished()).toMatch(/^Ortho: 4 of 5/)
    t = 500_000
    expect(p.finished()).toBeNull()
    expect(p.label()).toBe('block 5 of 5')
  })

  it('says nothing for a single block', () => {
    const p = createBlockProgress(1, { now: () => 0 })
    expect(p.finished()).toBeNull()
  })
})

import { describe, expect, it } from 'vitest'
import { createBlockProgress, createStepProgress, createLogPacer } from './blockProgress.js'

describe('createBlockProgress', () => {
  it('logs the first block, then at growing intervals, never the last', () => {
    let t = 0
    const p = createBlockProgress(5, { prefix: 'Ortho: ', now: () => t })
    expect(p.label()).toBe('block 1 of 5')
    t = 110_000
    expect(p.finished()).toBe('Ortho: 1 of 5 blocks done (20%) in 1:50, 110 s per block, about 7 minutes left')
    expect(p.label()).toBe('block 2 of 5')
    t = 120_000
    expect(p.finished()).toBeNull()
    t = 150_000 // 40 s since the last line: the wait is 1 min now
    expect(p.finished()).toBeNull()
    t = 400_000
    expect(p.finished()).toMatch(/^Ortho: 4 of 5 blocks done \(80%\) in 6:40, 100 s per block/)
    t = 500_000
    expect(p.finished()).toBeNull()
    expect(p.label()).toBe('block 5 of 5')
  })

  it('does not say "about less than a minute"', () => {
    let t = 0
    const p = createBlockProgress(3, { now: () => t })
    t = 1500
    expect(p.finished()).toMatch(/1\.5 s per block, less than a minute left$/)
  })

  it('says nothing for a single block', () => {
    const p = createBlockProgress(1, { now: () => 0 })
    expect(p.finished()).toBeNull()
  })
})

describe('createLogPacer', () => {
  it('waits 30 s, then twice as long each time, up to 5 min', () => {
    let t = 0
    const pace = createLogPacer({ now: () => t })
    const at = []
    for (t = 0; t <= 1_800_000; t += 1_000)
      if (pace.due()) {
        pace.spoke()
        at.push(t / 1000)
      }
    expect(at).toEqual([30, 90, 210, 450, 750, 1050, 1350, 1650])
  })
})

describe('createStepProgress', () => {
  it('reports steps when the pacer allows, with the time left from the rate', () => {
    let t = 0
    const hb = createStepProgress({ prefix: 'Ortho: ', unit: 'map visit', now: () => t })
    t = 10_000
    expect(hb.step(10, 1000, 'group 1 of 3')).toBeNull()
    t = 30_000
    expect(hb.step(30, 1000, 'group 1 of 3')).toBe(
      'Ortho: group 1 of 3 — 30 of 1,000 map visits (3%) in 0:30, about 15 minutes left',
    )
    t = 80_000
    expect(hb.step(80, 1000)).toBeNull()
    t = 90_000
    expect(hb.step(90, 1000)).toMatch(/^Ortho: 90 of 1,000 map visits/)
    expect(hb.step(1000, 1000)).toBeNull()
  })

  it('shares its pace with the block lines: whichever speaks, the other waits', () => {
    let t = 0
    const pacer = createLogPacer({ now: () => t })
    const hb = createStepProgress({ unit: 'map visit', pacer })
    const blocks = createBlockProgress(10, { pacer })
    t = 40_000
    expect(blocks.finished()).not.toBeNull() // the first block always speaks
    t = 70_000
    expect(hb.step(5, 100)).toBeNull() // 30 s after the block line; the wait is 1 min now
    t = 100_000
    expect(hb.step(6, 100)).not.toBeNull()
    t = 150_000
    expect(blocks.finished()).toBeNull() // 50 s after; the wait is 2 min now
  })
})

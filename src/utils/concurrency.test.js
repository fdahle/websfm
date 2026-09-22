import { describe, expect, it } from 'vitest'
import { mapConcurrent } from './concurrency.js'

describe('mapConcurrent', () => {
  it('preserves order and caps in-flight work', async () => {
    let active = 0
    let peak = 0
    const result = await mapConcurrent([4, 3, 2, 1], 2, async (value) => {
      active++
      peak = Math.max(peak, active)
      await new Promise((resolve) => setTimeout(resolve, value))
      active--
      return value * 2
    })
    expect(result).toEqual([8, 6, 4, 2])
    expect(peak).toBe(2)
  })

  it('rejects when a worker rejects', async () => {
    await expect(mapConcurrent([1, 2, 3], 2, async (value) => {
      if (value === 2) throw new Error('failed')
      return value
    })).rejects.toThrow('failed')
  })
})

import { expect, it } from 'vitest'
import { createDescriptorCache } from './descriptorCache.js'

const img = (uuid) => ({ uuid })
const desc = (n) => new Float32Array(n)
const settle = () => new Promise((r) => setTimeout(r, 0))

it('drops an image after its last pair', async () => {
  const a = img('a'),
    b = img('b'),
    c = img('c')
  const cache = createDescriptorCache({
    pairs: [
      [a, b],
      [a, c],
    ],
  })
  cache.set('a', Promise.resolve(desc(4)))
  cache.set('b', Promise.resolve(desc(4)))
  await settle()
  cache.release('a')
  cache.release('b')
  expect(cache.has('a')).toBe(true) // a still has the (a, c) pair
  expect(cache.has('b')).toBe(false) // b is done
  cache.release('a')
  expect(cache.has('a')).toBe(false)
  expect(cache.stats().residentBytes).toBe(0)
})

it('evicts least recently used entries over its byte budget, never one still loading', async () => {
  const cache = createDescriptorCache({ budgetBytes: 2 * 16 })
  cache.set('a', Promise.resolve(desc(4)))
  await settle()
  cache.set('b', Promise.resolve(desc(4)))
  await settle()
  cache.get('a') // a is now more recent than b
  let finish
  cache.set(
    'loading',
    new Promise((r) => {
      finish = r
    }),
  )
  cache.set('c', Promise.resolve(desc(4)))
  await settle()
  expect(cache.has('b')).toBe(false) // least recently used of the resolved ones
  expect(cache.has('a')).toBe(true)
  expect(cache.has('loading')).toBe(true)
  finish(desc(4))
  await settle()
  expect(cache.stats().residentBytes).toBeLessThanOrEqual(2 * 16)
})

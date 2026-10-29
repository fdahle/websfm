import { afterEach, expect, it, vi } from 'vitest'
import {
  discardAllPersistenceFailures,
  flushPersistence,
  persistenceFailures,
  retryPersistence,
  trackPersistence,
} from './persistence.js'
import { setStorageFullHandler } from './storageFull.js'

const full = () => Object.assign(new Error('Storage is full'), { name: 'QuotaExceededError', storageFull: true })

afterEach(() => {
  setStorageFullHandler(null)
  discardAllPersistenceFailures()
})

it('asks once when writes find storage full, and saves them after the project moved', async () => {
  let moved = false
  const handler = vi.fn(async () => (moved = true))
  setStorageFullHandler(handler)
  const write = vi.fn(async () => {
    if (!moved) throw full()
  })
  await Promise.all([trackPersistence('a', write), trackPersistence('b', write)])
  expect(handler).toHaveBeenCalledTimes(1)
  expect(write).toHaveBeenCalledTimes(4) // each once into the full storage, once after the move
  await expect(flushPersistence()).resolves.toBeUndefined()
})

it('after a "no", the saves stay failed and nothing is asked again until they are cleared', async () => {
  const handler = vi.fn(async () => false)
  setStorageFullHandler(handler)
  const write = vi.fn(async () => {
    throw full()
  })
  await trackPersistence('a', write).catch(() => {})
  await trackPersistence('b', write).catch(() => {})
  expect(handler).toHaveBeenCalledTimes(1)
  expect(persistenceFailures.value.map((f) => f.key)).toEqual(['a', 'b'])
  // Dismissed, the next full write asks again.
  discardAllPersistenceFailures()
  expect(persistenceFailures.value).toEqual([])
  await trackPersistence('c', write).catch(() => {})
  expect(handler).toHaveBeenCalledTimes(2)
})

it('does not ask for other errors, and a retry after the space was freed clears the card', async () => {
  const handler = vi.fn(async () => true)
  setStorageFullHandler(handler)
  let fail = true
  const write = vi.fn(async () => {
    if (fail) throw new Error('NotReadableError')
  })
  await trackPersistence('a', write).catch(() => {})
  expect(handler).not.toHaveBeenCalled()
  expect(persistenceFailures.value).toHaveLength(1)
  fail = false
  await retryPersistence()
  expect(persistenceFailures.value).toEqual([])
})

it('a write begun while the question is open fails without waiting on it', async () => {
  let release
  const handler = vi.fn(() => new Promise((resolve) => (release = resolve)))
  setStorageFullHandler(handler)
  const first = trackPersistence('a', async () => {
    throw full()
  })
  await vi.waitFor(() => expect(handler).toHaveBeenCalled())
  // The move's own write, say: it must not wait for the move to finish.
  await expect(
    trackPersistence('index', async () => {
      throw full()
    }),
  ).rejects.toThrow('Storage is full')
  release(false)
  await expect(first).rejects.toThrow('Storage is full')
  expect(handler).toHaveBeenCalledTimes(1)
})

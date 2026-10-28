import { afterEach, expect, it, vi } from 'vitest'
import { setStorageFullHandler, storageFullRetry } from './storageFull.js'

const full = () => Object.assign(new Error('Storage is full'), { name: 'QuotaExceededError', storageFull: true })

afterEach(() => setStorageFullHandler(null))

it('asks once, waits for the writes in flight, and retries every failed write after a move', async () => {
  let settled = false
  const inFlight = new Promise((resolve) => setTimeout(resolve, 5)).then(() => (settled = true))
  const handler = vi.fn(async () => {
    expect(settled).toBe(true) // the copy starts after the writes in flight
    return true
  })
  setStorageFullHandler(handler)
  const retry = storageFullRetry({ projectId: 'p', settleFirst: () => [inFlight] })
  const results = await Promise.all([retry(full(), async () => 'a'), retry(full(), async () => 'b')])
  expect(results).toEqual(['a', 'b'])
  expect(handler).toHaveBeenCalledTimes(1)
  expect(handler).toHaveBeenCalledWith({ projectId: 'p' })
})

it('after a "stop", every failed write fails with its own error and nothing is asked again', async () => {
  const handler = vi.fn(async () => false)
  setStorageFullHandler(handler)
  const retry = storageFullRetry({ projectId: 'p' })
  const write = vi.fn()
  const first = full()
  await expect(retry(first, write)).rejects.toBe(first)
  await expect(retry(full(), write)).rejects.toThrow('Storage is full')
  expect(handler).toHaveBeenCalledTimes(1)
  expect(write).not.toHaveBeenCalled()
})

it('passes on other errors, and storage full when no handler is registered', async () => {
  const handler = vi.fn(async () => true)
  setStorageFullHandler(handler)
  const other = new Error('NotFoundError')
  await expect(storageFullRetry({ projectId: 'p' })(other, vi.fn())).rejects.toBe(other)
  expect(handler).not.toHaveBeenCalled()
  setStorageFullHandler(null)
  const err = full()
  await expect(storageFullRetry({ projectId: 'p' })(err, vi.fn())).rejects.toBe(err)
})

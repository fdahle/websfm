import { describe, it, expect } from 'vitest'
import { createKeyedQueue, QueueCancelled } from './keyedQueue.js'
import { thumbnailSize, decodeResizeOptions } from './thumbnail.js'

const deferred = () => {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createKeyedQueue', () => {
  it('bounds concurrency and runs everything', async () => {
    const q = createKeyedQueue({ concurrency: 2 })
    const gates = [deferred(), deferred(), deferred()]
    let running = 0,
      peak = 0
    const out = gates.map((g, i) =>
      q.request(`k${i}`, async () => {
        running++
        peak = Math.max(peak, running)
        await g.promise
        running--
        return i
      }),
    )
    await flush()
    expect(q.active).toBe(2)
    expect(q.pending).toBe(1)
    gates.forEach((g) => g.resolve())
    expect(await Promise.all(out)).toEqual([0, 1, 2])
    expect(peak).toBe(2)
  })

  it('shares one promise per key while queued or running', async () => {
    const q = createKeyedQueue({ concurrency: 1 })
    let calls = 0
    const a = q.request('x', async () => {
      calls++
      return 'a'
    })
    const b = q.request('x', async () => {
      calls++
      return 'b'
    })
    expect(a).toBe(b)
    expect(await a).toBe('a')
    expect(calls).toBe(1)
    // Settled ⇒ the key is free again.
    expect(await q.request('x', async () => 'again')).toBe('again')
  })

  it('runs urgent requests ahead of the backlog, newest first', async () => {
    const q = createKeyedQueue({ concurrency: 1 })
    const gate = deferred()
    const order = []
    const first = q.request('busy', () => gate.promise)
    const jobs = ['a', 'b', 'c'].map((k) =>
      q.request(k, async () => {
        order.push(k)
      }),
    )
    const urgent = q.request(
      'u',
      async () => {
        order.push('u')
      },
      { urgent: true },
    )
    q.request('b', async () => {}, { urgent: true }) // promote an already-queued key
    gate.resolve()
    await Promise.all([first, ...jobs, urgent])
    expect(order).toEqual(['b', 'u', 'a', 'c'])
  })

  it('cancelPending rejects queued work only', async () => {
    const q = createKeyedQueue({ concurrency: 1 })
    const gate = deferred()
    const running = q.request('run', () => gate.promise.then(() => 'done'))
    const queued = q.request('later', async () => 'never')
    await flush()
    expect(q.cancelPending('switch')).toBe(1)
    await expect(queued).rejects.toBeInstanceOf(QueueCancelled)
    expect(q.has('later')).toBe(false)
    gate.resolve()
    expect(await running).toBe('done')
  })

  it('a failing task rejects its callers and frees the slot', async () => {
    const q = createKeyedQueue({ concurrency: 1 })
    await expect(
      q.request('bad', async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(await q.request('good', async () => 1)).toBe(1)
  })
})

describe('thumbnail sizing', () => {
  it('fits the long side to maxDim without upscaling', () => {
    expect(thumbnailSize(4000, 3000, 256)).toEqual({ width: 256, height: 192 })
    expect(thumbnailSize(3000, 4000, 256)).toEqual({ width: 192, height: 256 })
    expect(thumbnailSize(100, 50, 256)).toEqual({ width: 100, height: 50 })
    expect(thumbnailSize(10000, 10, 256)).toEqual({ width: 256, height: 1 })
  })
  it('asks the decoder for the long side only', () => {
    expect(decodeResizeOptions({ width: 4000, height: 3000 })).toMatchObject({ resizeWidth: 256 })
    expect(decodeResizeOptions({ width: 3000, height: 4000 })).toMatchObject({ resizeHeight: 256 })
    expect(decodeResizeOptions(null)).toMatchObject({ resizeWidth: 256 })
    expect(decodeResizeOptions({ width: 200, height: 100 })).not.toHaveProperty('resizeWidth')
  })
})

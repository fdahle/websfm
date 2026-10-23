import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  bigArrayCaps,
  localArrays,
  sharedArrays,
  chunksOf,
  isSharedArray,
  localArray,
  postableCopy,
  setBigArrayCaps,
  shareableArray,
  transferList,
  viewAs,
} from './bigArray.js'
import { MAX_BUFFER_BYTES, isBufferAllocationFailure } from './bufferLimit.js'

afterEach(() => setBigArrayCaps(null))

describe('bigArrayCaps', () => {
  it('finds wasm memories in Node, and their limits at least the plain one', () => {
    const c = bigArrayCaps()
    expect(c.wasm).toBe(true)
    expect(c.maxLocalBytes).toBeGreaterThanOrEqual(4 * 2 ** 30)
    expect(c.maxShareableBytes).toBeGreaterThanOrEqual(MAX_BUFFER_BYTES)
  })
})

describe('localArray', () => {
  it('stays a plain array below the threshold', () => {
    const a = localArray(Float64Array, 10)
    expect(a.buffer).toBeInstanceOf(ArrayBuffer)
    expect(a.buffer.byteLength).toBe(80)
  })

  it('lives in its own zeroed wasm memory from the threshold, a page multiple long', () => {
    const a = localArray(Float32Array, 1000, { minBytes: 0 })
    expect(a.length).toBe(1000)
    expect(a.every((v) => v === 0)).toBe(true)
    expect(a.buffer.byteLength).toBe(65536) // whole pages: longer than the array
    expect(isSharedArray(a)).toBe(false)
  })

  it('refuses past the largest memory with the error the buffer-limit messages know', () => {
    setBigArrayCaps({ wasm: true, memory64: false, shared: false, maxLocalBytes: 1024, maxShareableBytes: 1024 })
    let err
    try {
      localArray(Uint8Array, 2048, { minBytes: 0 })
    } catch (e) {
      err = e
    }
    expect(isBufferAllocationFailure(err)).toBe(true)
  })

  it('without wasm memories, is a plain array (and the plain limit applies)', () => {
    setBigArrayCaps({
      wasm: false,
      memory64: false,
      shared: false,
      maxLocalBytes: MAX_BUFFER_BYTES,
      maxShareableBytes: MAX_BUFFER_BYTES,
    })
    expect(localArray(Uint8Array, 100, { minBytes: 0 }).buffer.byteLength).toBe(100)
  })
})

describe('shareableArray', () => {
  it('is a plain array up to the plain limit, exactly as before', () => {
    const a = shareableArray(Float32Array, 30)
    expect(a.buffer).toBeInstanceOf(ArrayBuffer)
    expect(a.buffer.byteLength).toBe(120)
  })

  it('past it, shared wasm memory', () => {
    const a = shareableArray(Float32Array, 30, { maxPlainBytes: 0 })
    expect(isSharedArray(a)).toBe(true)
    expect(a.length).toBe(30)
  })

  it('without shared memory (no cross-origin isolation), stays plain, as far as plain goes', () => {
    setBigArrayCaps({ wasm: true, memory64: false, shared: false, maxLocalBytes: 2 ** 32, maxShareableBytes: 0 })
    expect(isSharedArray(shareableArray(Uint8Array, 10, { maxPlainBytes: 0 }))).toBe(false)
    expect(() => shareableArray(Uint8Array, MAX_BUFFER_BYTES + 1, { maxPlainBytes: 0 })).toThrow(RangeError)
  })
})

describe('posting', () => {
  it('transferList keeps plain buffers once and leaves shared ones out', () => {
    const p = new Float32Array(4)
    const s = shareableArray(Float32Array, 4, { maxPlainBytes: 0 })
    expect(transferList([p, p.buffer, s, s.buffer, null, undefined])).toEqual([p.buffer])
  })

  it('postableCopy copies a plain array and views a shared one', () => {
    const p = Float32Array.from([1, 2, 3])
    const pc = postableCopy(p, 2)
    expect([...pc]).toEqual([1, 2])
    expect(pc.buffer).not.toBe(p.buffer)
    const s = shareableArray(Float32Array, 3, { maxPlainBytes: 0 })
    s.set([4, 5, 6])
    const sc = postableCopy(s, 2)
    expect([...sc]).toEqual([4, 5])
    expect(sc.buffer).toBe(s.buffer)
  })

  it('a shared array survives structured cloning as the same memory', () => {
    const s = shareableArray(Uint32Array, 8, { maxPlainBytes: 0 })
    const c = structuredClone(s)
    c[3] = 9
    expect(s[3]).toBe(9)
  })
})

describe('chunksOf / viewAs', () => {
  it('yields a small plain array uncopied, a shared one as plain copies in order', () => {
    const p = Uint8Array.from([1, 2, 3])
    expect([...chunksOf(p)][0].buffer).toBe(p.buffer)
    const s = shareableArray(Uint8Array, 10, { maxPlainBytes: 0 })
    s.set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
    const parts = [...chunksOf(s, 4)]
    expect(parts.map((c) => c.length)).toEqual([4, 4, 2])
    expect(parts.every((c) => c.buffer instanceof ArrayBuffer)).toBe(true)
    expect(parts.flatMap((c) => [...c])).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9])
  })

  it('viewAs reads a buffer or a view without copying and without the memory tail', () => {
    const s = shareableArray(Uint8Array, 8, { maxPlainBytes: 0 })
    const f = viewAs(Float32Array, s)
    expect(f.length).toBe(2)
    f[1] = 2
    expect(viewAs(Float32Array, s.buffer)[1]).toBe(2)
    expect(viewAs(Float32Array, new ArrayBuffer(8)).length).toBe(2)
  })
})

describe('groups', () => {
  it('arrays made together share one memory, each at its own aligned offset', () => {
    const [a, b, c] = localArrays(
      [
        [Float64Array, 3],
        [Uint8Array, 5],
        [Float32Array, 7],
      ],
      { minBytes: 0 },
    )
    expect(a.buffer).toBe(b.buffer)
    expect(b.buffer).toBe(c.buffer)
    expect([a.byteOffset, b.byteOffset, c.byteOffset]).toEqual([0, 32, 48])
    a.fill(1)
    b.fill(2)
    c.fill(3)
    expect([...a, ...b, ...c]).toEqual([1, 1, 1, 2, 2, 2, 2, 2, 3, 3, 3, 3, 3, 3, 3])
  })

  it('a shared group goes to shared memory once it is large, whatever each array is', () => {
    const [p, q] = sharedArrays([
      [Float32Array, 2 ** 24],
      [Uint8Array, 2 ** 24],
    ])
    expect(isSharedArray(p) && p.buffer === q.buffer).toBe(true)
    expect(isSharedArray(sharedArrays([[Float32Array, 10]])[0])).toBe(false) // small: plain
  })

  it('falls back to plain arrays when the engine refuses another memory', () => {
    const spy = vi.spyOn(WebAssembly, 'Memory').mockImplementation(() => {
      throw new RangeError('WebAssembly.Memory(): could not allocate memory')
    })
    try {
      const [a, b] = localArrays(
        [
          [Float32Array, 4],
          [Uint32Array, 4],
        ],
        { minBytes: 0 },
      )
      expect(a.buffer).not.toBe(b.buffer)
      expect(a.buffer.byteLength).toBe(16)
    } finally {
      spy.mockRestore()
    }
  })

  it('a local array is copied, never transferred (its memory cannot be detached)', () => {
    const a = localArray(Float32Array, 4, { minBytes: 0 })
    const p = new Float32Array(4)
    expect(transferList([a, p])).toEqual([p.buffer])
  })
})

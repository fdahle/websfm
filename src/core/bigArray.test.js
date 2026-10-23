import { afterEach, describe, expect, it } from 'vitest'
import {
  bigArrayCaps,
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

  it('without shared memory (no cross-origin isolation), refuses past the plain limit', () => {
    setBigArrayCaps({ wasm: true, memory64: false, shared: false, maxLocalBytes: 2 ** 32, maxShareableBytes: 0 })
    expect(() => shareableArray(Uint8Array, 10, { maxPlainBytes: 0 })).toThrow(RangeError)
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

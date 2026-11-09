import { afterEach, describe, it, expect } from 'vitest'
import { joinCloudParts } from './cloudParts.js'
import { isSharedArray, setBigArrayCaps } from '../bigArray.js'

const part = (count, base) => ({
  count,
  pos: Float32Array.from({ length: 3 * count }, (_, i) => base + i),
  col: Uint8Array.from({ length: 3 * count }, (_, i) => (base + i) % 256),
  nrm: Float32Array.from({ length: 3 * count }, (_, i) => -(base + i)),
})

describe('joinCloudParts', () => {
  afterEach(() => setBigArrayCaps(null))

  it('joins the slabs in order and lets each go once copied', () => {
    const parts = [part(2, 0), part(0, 100), part(3, 200)]
    const cloud = joinCloudParts(parts)
    expect(cloud.count).toBe(5)
    expect(Array.from(cloud.pos)).toEqual([0, 1, 2, 3, 4, 5, 200, 201, 202, 203, 204, 205, 206, 207, 208])
    expect(Array.from(cloud.col.subarray(6, 9))).toEqual([200, 201, 202])
    expect(cloud.nrm[14]).toBe(-208)
    expect(parts).toEqual([null, null, null])
  })

  it('returns a single slab as it is', () => {
    const p = part(4, 0)
    expect(joinCloudParts([p])).toBe(p)
  })

  // Node is not cross-origin isolated; a large cloud there takes shared memory only where
  // the realm offers it.
  it('puts a large cloud in shared memory where the page is isolated', () => {
    if (typeof SharedArrayBuffer === 'undefined') return
    setBigArrayCaps({ wasm: true, memory64: false, shared: true, maxLocalBytes: 2 ** 32, maxShareableBytes: 2 ** 32 })
    const big = 1_000_000 // 27 MB a million points; three of them pass LOCAL_MIN_BYTES
    const cloud = joinCloudParts([part(big, 0), part(big, 1), part(big, 2)])
    expect(isSharedArray(cloud.pos) && isSharedArray(cloud.col) && isSharedArray(cloud.nrm)).toBe(true)
    expect(cloud.pos[3 * big]).toBe(1)
  })
})

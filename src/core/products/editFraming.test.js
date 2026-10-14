import { describe, it, expect } from 'vitest'
import { settleEditLatch } from './editFraming.js'

const posA = new Float32Array(3), posA2 = new Float32Array(3), posB = new Float32Array(3)
const cloudA = { id: 'a', pos: posA, count: 1 }
const cloudB = { id: 'b', pos: posB, count: 1 }
const drawn = (...clouds) => (id) => clouds.find((c) => c.id === id)

describe('settleEditLatch', () => {
  it('is inert with nothing latched', () => {
    const r = settleEditLatch(new Set(), [cloudA], drawn(cloudA), true)
    expect(r.editResult).toBe(false)
    expect(r.pending.size).toBe(0)
  })

  it('a fork (new cloud + source hidden) is an edit result: no re-frame', () => {
    const clouds = [{ ...cloudA, visible: false }, { id: 'a-edit', pos: new Float32Array(3), count: 1 }]
    const r = settleEditLatch(new Set(['a']), clouds, drawn(cloudA), true)
    expect(r.editResult).toBe(true)
    expect([...r.pending]).toEqual([])
  })

  it('in-place refinement (same id, new buffer) settles the latch', () => {
    const r = settleEditLatch(new Set(['a']), [{ ...cloudA, pos: posA2 }], drawn(cloudA), false)
    expect(r.editResult).toBe(true)
    expect(r.pending.size).toBe(0)
  })

  it('an unrelated update (restyle, rename) keeps the latch', () => {
    const r = settleEditLatch(new Set(['a']), [{ ...cloudA, name: 'renamed' }], drawn(cloudA), false)
    expect(r.editResult).toBe(false)
    expect([...r.pending]).toEqual(['a'])
  })

  it('after a failed/cancelled edit, a later import frames and drops the stale latch', () => {
    const imported = { id: 'new', pos: new Float32Array(3), count: 1 }
    const r = settleEditLatch(new Set(['a']), [cloudA, imported], drawn(cloudA), true)
    expect(r.editResult).toBe(false)
    expect(r.pending.size).toBe(0)
  })

  it('a multi-cloud edit settles one result at a time', () => {
    const first = [{ ...cloudA, visible: false }, cloudB, { id: 'a-edit', pos: new Float32Array(3), count: 1 }]
    const r1 = settleEditLatch(new Set(['a', 'b']), first, drawn(cloudA, cloudB), true)
    expect(r1.editResult).toBe(true)
    expect([...r1.pending]).toEqual(['b'])
    const r2 = settleEditLatch(r1.pending, [...first.slice(0, 1), { ...cloudB, visible: false }, first[2], { id: 'b-edit', pos: new Float32Array(3), count: 1 }], drawn(cloudB), true)
    expect(r2.editResult).toBe(true)
    expect(r2.pending.size).toBe(0)
  })

  it('a cloud removed while its edit ran settles (clearing the scene, too)', () => {
    const r = settleEditLatch(new Set(['a']), [], drawn(cloudA), false)
    expect(r.editResult).toBe(true)
    expect(r.pending.size).toBe(0)
  })
})

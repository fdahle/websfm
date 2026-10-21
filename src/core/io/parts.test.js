import { describe, it, expect } from 'vitest'
import {
  jsonParts,
  lazyArray,
  joinParts,
  lineParts,
  recordParts,
  chunkedByteWriter,
  textBuffer,
  jsonArrayItemParts,
  jsonArrayEnd,
} from './parts.js'

const json = (v, opts) => joinParts(jsonParts(v, opts))

describe('jsonParts — byte-identical to JSON.stringify', () => {
  const date = new Date(Date.UTC(2026, 9, 10, 12, 0, 0))
  const cases = {
    primitives: [1, -0, 1.5e-7, NaN, Infinity, 'é"\\\n ', true, false, null],
    empty: { a: [], b: {}, c: [[]], d: [{}] },
    dropped: { a: undefined, f: () => 1, s: Symbol('x'), keep: 1, arr: [undefined, () => 1, Symbol('y')] },
    allDropped: { a: undefined, b: () => 1 },
    toJSON: { date, custom: { toJSON: (k) => `key:${k}` }, nested: [{ toJSON: () => ({ z: [1, 2] }) }] },
    boxed: [new Number(3), new String('s'), new Boolean(false)],
    typed: { u32: Uint32Array.from([1, 2, 3]), f32: Float32Array.from([0.5]), map: new Map([[1, 2]]) },
    deep: { a: { b: { c: [1, [2, [3, { d: 'e' }]]] } } },
    keyOrder: { b: 1, 2: 'two', a: 2, 1: 'one' },
    sparse: [1, , 3], // eslint-disable-line no-sparse-arrays
    bigFlat: Array.from({ length: 5000 }, (_, i) => i * 0.1),
    bigObjects: Array.from({ length: 300 }, (_, i) => ({ x: i, y: [i, i + 1], name: `p${i}` })),
  }
  for (const [name, v] of Object.entries(cases)) {
    for (const space of [0, 2, 4, '\t']) {
      it(`${name}, space ${JSON.stringify(space)}`, () => {
        expect(json(v, { space })).toBe(JSON.stringify(v, null, space))
      })
    }
  }

  it('a top-level primitive, and nothing for a top-level undefined', () => {
    expect(json(42)).toBe('42')
    expect(json('x')).toBe('"x"')
    expect([...jsonParts(undefined)]).toEqual([])
  })

  it('a lazyArray serializes exactly like the array it stands for', () => {
    const items = Array.from({ length: 2000 }, (_, i) => ({ i, v: [i, -i], c: i % 3 ? null : undefined }))
    const doc = { head: 'h', items: lazyArray(items.length, (i) => items[i]), empty: lazyArray(0, () => 1) }
    for (const space of [0, 2]) {
      expect(json(doc, { space })).toBe(JSON.stringify({ head: 'h', items, empty: [] }, null, space))
    }
    // undefined / function elements become null, as in an array
    expect(json(lazyArray(3, (i) => (i === 1 ? undefined : i)))).toBe('[\n  0,\n  null,\n  2\n]')
  })

  it('materializes a lazy element only while writing it', () => {
    let live = 0,
      peak = 0
    const doc = lazyArray(1000, (i) => {
      live++
      peak = Math.max(peak, live)
      return { i }
    })
    const gen = jsonParts(doc, { partChars: 64 })
    for (const _ of gen) live = 0 // a drained part releases what it wrote
    expect(peak).toBeLessThan(20)
  })

  it('yields bounded parts for a large document', () => {
    const doc = { points: lazyArray(20000, (i) => ({ x: i, y: i / 3, views: [[`u${i}`, i]] })) }
    const parts = [...jsonParts(doc, { space: 2, partChars: 4096 })]
    expect(parts.length).toBeGreaterThan(50)
    // A part closes as soon as it reaches the limit, so it overshoots by at most one token.
    for (const p of parts) expect(p.length).toBeLessThan(4096 + 200)
    const flat = { points: Array.from({ length: 20000 }, (_, i) => ({ x: i, y: i / 3, views: [[`u${i}`, i]] })) }
    expect(parts.join('')).toBe(JSON.stringify(flat, null, 2))
  })

  it('throws on a cycle like JSON.stringify', () => {
    const a = { b: [] }
    a.b.push({ a })
    expect(() => json(a)).toThrow(TypeError)
    expect(() => json({ n: 10n })).toThrow(TypeError)
  })
})

describe('part helpers', () => {
  it('lineParts writes head, one line per item, and emptyBody only when empty', () => {
    expect(joinParts(lineParts('H\n', 3, (i) => `l${i}`))).toBe('H\nl0\nl1\nl2\n')
    expect(joinParts(lineParts('H\n', 0, () => 'x', { emptyBody: '\n' }))).toBe('H\n\n')
    expect(joinParts(lineParts('H\n', 0, () => 'x'))).toBe('H\n')
    const parts = [...lineParts('', 1000, (i) => String(i).padStart(9, '0'), { partChars: 100 })]
    expect(parts.length).toBeGreaterThan(50)
    expect(parts.every((p) => p.length <= 110 && p.endsWith('\n'))).toBe(true)
  })

  it('recordParts splits on whole records and keeps record order', () => {
    const parts = [...recordParts(10, 6, (dv, o, i) => dv.setUint16(o, i * 7, true), 20)]
    expect(parts.map((p) => p.length)).toEqual([18, 18, 18, 6])
    const all = joinParts(parts)
    const dv = new DataView(all.buffer)
    for (let i = 0; i < 10; i++) expect(dv.getUint16(i * 6, true)).toBe(i * 7)
    expect([...recordParts(0, 6, () => {})]).toEqual([])
  })

  it('chunkedByteWriter never splits a value and matches one contiguous write', () => {
    const w = chunkedByteWriter(10)
    w.u8(1)
    w.i32(-2)
    w.f64(Math.PI)
    w.u64(2 ** 40)
    w.i64(-1)
    w.bytes(new Uint8Array(25).fill(7))
    w.u8(9)
    const parts = w.done()
    expect(parts.length).toBeGreaterThan(2)
    const all = joinParts(parts)
    const dv = new DataView(all.buffer)
    expect(all.length).toBe(1 + 4 + 8 + 8 + 8 + 25 + 1)
    expect(dv.getUint8(0)).toBe(1)
    expect(dv.getInt32(1, true)).toBe(-2)
    expect(dv.getFloat64(5, true)).toBe(Math.PI)
    expect(Number(dv.getBigUint64(13, true))).toBe(2 ** 40)
    expect(Number(dv.getBigInt64(21, true))).toBe(-1)
    expect(all[29]).toBe(7)
    expect(all[53]).toBe(7)
    expect(all[54]).toBe(9)
  })

  it('joinParts returns a string for text parts and bytes otherwise', () => {
    expect(joinParts(['a', 'b'])).toBe('ab')
    expect(joinParts([])).toBe('')
    expect([...joinParts(['é', Uint8Array.of(1)])]).toEqual([0xc3, 0xa9, 1])
  })

  it('textBuffer reports a full part and resets on take', () => {
    const b = textBuffer(4)
    expect(b.add('ab')).toBe(false)
    expect(b.add('cd')).toBe(true)
    expect(b.take()).toBe('abcd')
    expect(b.size).toBe(0)
  })
})

describe('jsonArrayItemParts — an array written one element at a time', () => {
  const whole = (items, space) =>
    joinParts([
      ...items.flatMap((v, i) => [...jsonArrayItemParts(v, i, { space, partChars: 7 })]),
      jsonArrayEnd(items.length, { space }),
    ])
  const items = [
    { image: 'a.jpg', kpCount: 2, keypoints: lazyArray(2, (i) => ({ x: i, y: 2 * i })) },
    { image: 'b.jpg', nested: { list: [1, [2, 3]], empty: [], obj: {} } },
    { flat: [1, 2, 3] },
  ]
  const plain = items.map((v) => JSON.parse(joinParts([...jsonParts(v)])))
  it.each([2, 0, '\t'])('is byte-identical to JSON.stringify of the array (space %j)', (space) => {
    expect(whole(items, space)).toBe(JSON.stringify(plain, null, space))
    expect(whole(items.slice(0, 1), space)).toBe(JSON.stringify(plain.slice(0, 1), null, space))
    expect(whole([], space)).toBe('[]')
  })
})

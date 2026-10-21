import { describe, it, expect } from 'vitest'
import { partsToBlob, blobChunks, blobSource } from './blobParts.js'

const bytes = async (blob) => new Uint8Array(await blob.arrayBuffer())

describe('partsToBlob', () => {
  it('folds parts batch by batch into the same bytes as one Blob', async () => {
    const parts = Array.from({ length: 200 }, (_, i) => (i % 3 ? `line ${i} é\n` : Uint8Array.of(i, 255 - i)))
    const folded = partsToBlob(parts, 'text/plain', { batchBytes: 64 })
    expect(folded.type).toBe('text/plain')
    expect(await bytes(folded)).toEqual(await bytes(new Blob(parts)))
  })
  it('consumes a generator lazily and accepts Blob parts', async () => {
    let drawn = 0
    function* gen() {
      for (let i = 0; i < 5; i++) {
        drawn++
        yield `${i}`
      }
    }
    const blob = partsToBlob([new Blob(['a']), ...gen()])
    expect(drawn).toBe(5)
    expect(await blob.text()).toBe('a01234')
    expect((await partsToBlob([])).size).toBe(0)
  })
})

describe('blobChunks / blobSource', () => {
  const data = Uint8Array.from({ length: 1000 }, (_, i) => i % 251)
  it('reads a Blob in bounded slices from an offset', async () => {
    const chunks = []
    for await (const c of blobChunks(new Blob([data]), { start: 10, chunkBytes: 64 })) chunks.push(c)
    expect(chunks.every((c) => c.length <= 64)).toBe(true)
    const all = new Uint8Array(chunks.reduce((s, c) => s + c.length, 0))
    let o = 0
    for (const c of chunks) {
      all.set(c, o)
      o += c.length
    }
    expect(all).toEqual(data.subarray(10))
  })
  it('exposes size, ranged reads and chunks', async () => {
    const src = blobSource(new Blob([data]), 'x.bin')
    expect(src.name).toBe('x.bin')
    expect(src.size).toBe(1000)
    expect(await src.read(5, 9)).toEqual(data.subarray(5, 9))
    let total = 0
    for await (const c of src.chunks(900, 30)) total += c.length
    expect(total).toBe(100)
  })
})

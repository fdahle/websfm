import { it, expect } from 'vitest'
import { zipSync } from 'fflate'
import { readBoundedZip, ZIP_LIMITS } from './boundedZip.js'
const archive = files => new Blob([zipSync(files)])

it('extracts selected files and lists lazy image paths without inflating them', async () => {
  const result = await readBoundedZip(archive({ 'cameras.txt': new TextEncoder().encode('model'),
    'images/a.jpg': new Uint8Array(100_000) }), path => path === 'cameras.txt')
  expect(result.names).toEqual(['cameras.txt', 'images/a.jpg'])
  expect(result.entries).toHaveLength(1)
  expect(new TextDecoder().decode(result.entries[0].data)).toBe('model')
})
it('rejects traversal paths and excessive expansion', async () => {
  await expect(readBoundedZip(archive({ '../model': new Uint8Array(1) }), () => true)).rejects.toThrow('Unsafe')
  await expect(readBoundedZip(archive({ 'model': new Uint8Array(1_000_000) }), () => true)).rejects.toThrow(/limit/)
})
it('enforces total output and entry-count budgets', async () => {
  const file = archive({ a: new Uint8Array([1,2,3]), b: new Uint8Array([4,5,6]) })
  await expect(readBoundedZip(file, () => true, { ...ZIP_LIMITS, expanded: 5 })).rejects.toThrow('limit')
  await expect(readBoundedZip(file, () => true, { ...ZIP_LIMITS, entries: 1 })).rejects.toThrow('too many')
})

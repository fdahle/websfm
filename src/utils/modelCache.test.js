import { it, expect, vi, afterEach } from 'vitest'
import { MIN_MODEL_BYTES } from '../core/models/modelCache.js'
import { readCachedModel, isModelCached, loadModelBytes } from './modelCache.js'

afterEach(() => vi.unstubAllGlobals())

const html = new TextEncoder().encode('\n<!doctype html><html><head></head></html>')
const onnx = () => {
  const b = new Uint8Array(MIN_MODEL_BYTES * 2)
  b[0] = 0x08
  b[1] = 0x07
  return b
}

it('evicts a cached HTML page instead of handing it to ORT', async () => {
  const del = vi.fn(async () => true)
  vi.stubGlobal('caches', {
    open: async () => ({ match: async () => ({ arrayBuffer: async () => html.buffer }), delete: del }),
  })
  expect(await readCachedModel('/models/superpoint.onnx')).toBeNull()
  expect(del).toHaveBeenCalledWith('/models/superpoint.onnx')
})

it('reports a too-small cached entry as missing, from its headers alone', async () => {
  const del = vi.fn(async () => true)
  const headers = new Map([['content-length', '1200']])
  vi.stubGlobal('caches', { open: async () => ({ match: async () => ({ headers }), delete: del }) })
  expect(await isModelCached('/models/superpoint.onnx')).toBe(false)
  expect(del).toHaveBeenCalled()
})

it('throws a named error when the fetch fallback returns HTML with 200', async () => {
  vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined }) })
  vi.stubGlobal('fetch', async () => new Response(html, { status: 200, headers: { 'content-type': 'text/html' } }))
  await expect(loadModelBytes('/models/superpoint.onnx', null, 'SuperPoint')).rejects.toThrow(
    /SuperPoint: \/models\/superpoint.onnx is not an ONNX model.*public\/models/,
  )
})

it('passes real model bytes through', async () => {
  const bytes = onnx()
  vi.stubGlobal('caches', { open: async () => ({ match: async () => undefined }) })
  vi.stubGlobal(
    'fetch',
    async () => new Response(bytes, { status: 200, headers: { 'content-type': 'application/octet-stream' } }),
  )
  expect((await loadModelBytes('/m.onnx')).byteLength).toBe(bytes.length)
})

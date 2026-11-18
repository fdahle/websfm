import { it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import worker, { PAGE_HEADERS, pinnedKey } from '../../deploy/cloudflare/worker.js'

// A bucket holding `files` ({ key: text }), with R2's list() by delimiter.
function bucket(files = {}) {
  return {
    get: async (key) =>
      key in files ? { body: files[key], size: files[key].length, httpEtag: '"e"', writeHttpMetadata: () => {} } : null,
    list: async ({ prefix, delimiter }) => {
      const dirs = new Set()
      for (const key of Object.keys(files)) {
        if (!key.startsWith(prefix)) continue
        const cut = key.indexOf(delimiter, prefix.length)
        if (cut >= 0) dirs.add(key.slice(0, cut + 1))
      }
      return { delimitedPrefixes: [...dirs], truncated: false }
    },
  }
}
const assets = { fetch: async () => new Response('asset') }
const get = (path, files) =>
  worker.fetch(new Request(`https://websfm.app${path}`), { LARGE_FILES: bucket(files), ASSETS: assets })

it('answers a malformed URL escape with 400, not a crash', async () => {
  expect((await get('/models/%E0%A4%A.onnx')).status).toBe(400)
  // A well-formed missing model stays a 404.
  expect((await get('/models/none.onnx')).status).toBe(404)
})

it('maps a pinned version path to its R2 key, sharing ORT across versions', () => {
  expect(pinnedKey('/v/0.9.0/')).toEqual({ key: 'v/0.9.0/index.html' })
  expect(pinnedKey('/v/0.9.0/assets/index-abc.js')).toEqual({ key: 'v/0.9.0/assets/index-abc.js' })
  expect(pinnedKey('/v/1.0.0-beta.2/sw.js')).toEqual({ key: 'v/1.0.0-beta.2/sw.js' })
  expect(pinnedKey('/v/0.9.0/ort/1.27.0/ort-wasm-simd-threaded.wasm')).toEqual({
    key: 'ort/1.27.0/ort-wasm-simd-threaded.wasm',
  })
  expect(pinnedKey('/v/0.9.0')).toEqual({ redirect: '/v/0.9.0/' })
  // Not a version: no key, so a 404, never another file of the bucket.
  expect(pinnedKey('/v/latest/')).toBeNull()
  expect(pinnedKey('/v/../models/disk.onnx')).toBeNull()
})

it('serves a pinned version from R2 with its page headers, and 404s what it lacks', async () => {
  const files = { 'v/0.9.0/index.html': '<html>', 'v/0.9.0/assets/a-1.js': 'x' }
  const page = await get('/v/0.9.0/', files)
  expect(page.status).toBe(200)
  expect(page.headers.get('Content-Type')).toMatch(/^text\/html/)
  expect(page.headers.get('Cross-Origin-Embedder-Policy')).toBe('require-corp')
  expect(page.headers.get('Cache-Control')).toBe('no-cache')
  const chunk = await get('/v/0.9.0/assets/a-1.js', files)
  expect(chunk.headers.get('Content-Type')).toBe('text/javascript')
  expect(chunk.headers.get('Cache-Control')).toContain('immutable')
  // A missing file of a pinned version is a 404, not the newest version's asset.
  expect((await get('/v/0.9.0/assets/gone.js', files)).status).toBe(404)
  expect((await get('/v/0.8.0/', files)).status).toBe(404)
  const moved = await get('/v/0.9.0', files)
  expect(moved.status).toBe(301)
  expect(moved.headers.get('Location')).toBe('https://websfm.app/v/0.9.0/')
})

it('lists the pinned versions newest first', async () => {
  const files = {
    'v/0.9.0/index.html': '',
    'v/0.10.0/index.html': '',
    'v/0.9.1/index.html': '',
    'v/junk/index.html': '',
    'models/disk.onnx': '',
  }
  const res = await get('/v/versions.json', files)
  expect(await res.json()).toEqual({ versions: ['0.10.0', '0.9.1', '0.9.0'] })
})

it('sends the pages of a pinned version the headers _headers gives the newest one', () => {
  const text = readFileSync(new URL('../../public/_headers', import.meta.url), 'utf8')
  for (const [name, value] of Object.entries(PAGE_HEADERS)) expect(text).toContain(`${name}: ${value}`)
})

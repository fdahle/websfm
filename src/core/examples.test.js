import { it, expect } from 'vitest'
import { EXAMPLES, downloadExample, exampleBaseUrl, parseExampleManifest } from './examples.js'

const manifest = { files: [{ name: 'a.JPG', bytes: 3 }, { name: 'b.JPG', bytes: 2 }] }

function fakeFetch(routes) {
  const calls = []
  const fn = async (url) => {
    calls.push(url)
    const body = routes[url]
    if (body === undefined) return new Response('<!doctype html>', { status: 404 })
    if (typeof body === 'object' && !(body instanceof Blob)) return new Response(JSON.stringify(body))
    return new Response(body)
  }
  return { fn, calls }
}

it('serves every example from the examples folder of the site', () => {
  expect(exampleBaseUrl()).toMatch(/examples\/$/)
  for (const e of Object.values(EXAMPLES)) {
    expect(['aerial', 'object']).toContain(e.sceneType)
    expect(e.license).toBeTruthy()
  }
})

it('rejects manifests that are empty or name paths', () => {
  expect(parseExampleManifest(manifest)).toHaveLength(2)
  expect(() => parseExampleManifest({ files: [] })).toThrow(/no files/)
  expect(() => parseExampleManifest({ files: [{ name: '../x.jpg', bytes: 1 }] })).toThrow(/bad file name/)
  expect(() => parseExampleManifest({ files: [{ name: '.hidden', bytes: 1 }] })).toThrow(/bad file name/)
  expect(() => parseExampleManifest({ files: [{ name: 'a.jpg', bytes: 0 }] })).toThrow(/bad size/)
})

it('downloads the listed files in order, reporting progress', async () => {
  const base = `${exampleBaseUrl()}aukerman/`
  const { fn } = fakeFetch({
    [`${base}manifest.json`]: manifest,
    [`${base}a.JPG`]: new Blob(['abc'], { type: 'image/jpeg' }),
    [`${base}b.JPG`]: new Blob(['de'], { type: 'image/jpeg' }),
  })
  const seen = []
  const files = await downloadExample('aukerman', { fetchFn: fn, onProgress: (p) => seen.push(p) })
  expect(files.map((f) => f.name)).toEqual(['a.JPG', 'b.JPG'])
  expect(files[0].type).toBe('image/jpeg')
  expect(seen.at(-1)).toEqual({ done: 2, total: 2, bytes: 5, totalBytes: 5 })
})

it('names the missing URL and the fix when the example is not hosted', async () => {
  const { fn } = fakeFetch({})
  await expect(downloadExample('aukerman', { fetchFn: fn }))
    .rejects.toThrow(/examples\/aukerman\/manifest\.json: HTTP 404.*fetch:examples/)
})

it('refuses an unknown example id', async () => {
  await expect(downloadExample('nope', { fetchFn: async () => { throw new Error('no fetch') } }))
    .rejects.toThrow(/Unknown example/)
})

import { afterEach, describe, expect, it } from 'vitest'
import { coreIo, installCoreIo, resetCoreIo } from './coreIo.js'
import { ensureProjection, projDefinition } from './crs.js'

afterEach(() => resetCoreIo())

describe('coreIo', () => {
  it('a part nobody installed rejects with a message naming it', async () => {
    await expect(coreIo().fetch('x')).rejects.toThrow(/network.*"fetch" is not installed/)
  })
  it('calls what was installed', async () => {
    installCoreIo({ readAppJson: async (name) => ({ name }) })
    expect(await coreIo().readAppJson('a.json')).toEqual({ name: 'a.json' })
  })
  it('refuses a part it does not know', () => {
    expect(() => installCoreIo({ fetsch: () => {} })).toThrow(/Unknown core I\/O part/)
  })
})

describe('CRS lookup through the installed I/O', () => {
  it('fetches a code the catalog lacks from epsg.io and caches it in app storage', async () => {
    const urls = []
    const stored = {}
    const def = '+proj=tmerc +lat_0=0 +lon_0=9 +k=0.9996 +x_0=500000 +y_0=0 +ellps=WGS84 +units=m +no_defs'
    installCoreIo({
      fetch: async (url) => {
        urls.push(String(url))
        // The catalog (an empty one), then epsg.io.
        if (String(url).includes('epsg.io')) return new Response(def)
        return new Response('{}', { headers: { 'content-type': 'application/json' } })
      },
      readAppJson: async () => null,
      writeAppJson: async (name, data) => {
        stored[name] = data
      },
    })
    expect(await ensureProjection('EPSG:999123')).toBe(true)
    expect(urls.at(-1)).toBe('https://epsg.io/999123.proj4')
    expect(projDefinition('EPSG:999123')).toBe(def)
    expect(stored['crs-defs.json']).toEqual({ 'EPSG:999123': def })
  })
})

import { describe, expect, it } from 'vitest'
import { createSavedCloudFiles, heavyIdentity } from './savedCloudFiles.js'

const dense = (extra = {}) => ({
  id: 'd1', kind: 'dense', name: 'Dense', count: 2,
  pos: new Float32Array(6), col: new Uint8Array(6), ...extra,
})
const files = { pos: { name: 'a.pos.bin', bytes: 48 }, col: { name: 'a.col.bin', bytes: 6 } }

describe('savedCloudFiles', () => {
  it('reuses files while the heavy arrays are the same objects, whatever the metadata does', () => {
    const cache = createSavedCloudFiles()
    const c = dense()
    cache.remember(c, 'p1', files)
    expect(cache.lookup(c, 'p1')).toEqual(files)
    // Rename / hide / restyle mutate metadata in place, or re-wrap the cloud object.
    c.name = 'Renamed'; c.visible = false; c.style = { mode: 'rgb' }
    expect(cache.lookup(c, 'p1')).toEqual(files)
    expect(cache.lookup({ ...c, id: 'other' }, 'p1')).toEqual(files)
  })

  it('misses whenever the data may differ', () => {
    const cache = createSavedCloudFiles()
    const c = dense()
    cache.remember(c, 'p1', files)
    expect(cache.lookup({ ...c, pos: new Float32Array(6) }, 'p1')).toBeNull()      // new positions
    expect(cache.lookup({ ...c, col: new Uint8Array(6) }, 'p1')).toBeNull()        // new colours
    expect(cache.lookup({ ...c, nrm: new Float32Array(6) }, 'p1')).toBeNull()      // normals added
    expect(cache.lookup({ ...c, count: 1 }, 'p1')).toBeNull()                      // re-sliced
    expect(cache.lookup({ ...c, attributes: { d: new Float32Array(2) } }, 'p1')).toBeNull() // attribute added
    expect(cache.lookup(c, 'p2')).toBeNull()                                      // other project
    cache.clear()
    expect(cache.lookup(c, 'p1')).toBeNull()
  })

  it('notices an attribute added to the same attributes object', () => {
    const cache = createSavedCloudFiles()
    const c = dense({ attributes: { a: new Float32Array(2) } })
    cache.remember(c, 'p1', files)
    c.attributes.b = new Float32Array(2)
    expect(cache.lookup(c, 'p1')).toBeNull()
  })

  it('never caches sparse clouds or an incomplete file list', () => {
    const cache = createSavedCloudFiles()
    expect(heavyIdentity({ kind: 'sparse', points: [] })).toBeNull()
    const c = dense()
    cache.remember(c, 'p1', { col: files.col }) // no pos file ⇒ not a usable record
    expect(cache.lookup(c, 'p1')).toBeNull()
  })
})

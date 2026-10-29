import { describe, it, expect, beforeEach } from 'vitest'
import { migrateProjectFormat } from './formatMigration.js'
import { clearProjectRoot, setProjectRoot } from './base.js'
import { shouldArchivePath } from '../../core/io/projectArchive.js'

// An in-memory project folder. `failAfter` makes the (n+1)-th write throw, which is a
// tab that died in the middle of a migration.
let writes = 0
let failAfter = Infinity

function makeDir(name) {
  const files = new Map()
  const dirs = new Map()
  return {
    name,
    files,
    dirs,
    async *keys() {
      yield* dirs.keys()
      yield* files.keys()
    },
    async getDirectoryHandle(n, opts) {
      if (!dirs.has(n)) {
        if (!opts?.create) throw Object.assign(new Error(`no dir ${n}`), { name: 'NotFoundError' })
        dirs.set(n, makeDir(n))
      }
      return dirs.get(n)
    },
    async getFileHandle(n, opts) {
      if (!files.has(n)) {
        if (!opts?.create) throw Object.assign(new Error(`no file ${n}`), { name: 'NotFoundError' })
        files.set(n, { data: '' })
      }
      const entry = files.get(n)
      return {
        async getFile() {
          return { size: entry.data.length, text: async () => entry.data }
        },
        async createWritable() {
          let buf = ''
          return {
            async write(chunk) {
              buf += String(chunk)
            },
            async close() {
              if (writes++ >= failAfter) throw new Error('tab killed')
              entry.data = buf
            },
            async abort() {},
          }
        },
      }
    },
    async removeEntry(n) {
      if (!files.delete(n) && !dirs.delete(n)) throw Object.assign(new Error(`no ${n}`), { name: 'NotFoundError' })
    },
  }
}

const put = (dir, name, doc) => dir.files.set(name, { data: JSON.stringify(doc) })
const get = (dir, name) => (dir.files.has(name) ? JSON.parse(dir.files.get(name).data) : undefined)

// Version 1 → 2: rename a GCP field, tag every product, drop one product, add a document.
const steps = [
  {
    from: 1,
    note: 'test migration',
    documents: ['gcps.json', 'products/*.json', 'notes.json'],
    migrate(docs) {
      const g = docs['gcps.json']
      docs['gcps.json'] = { ...g, gcps: g.gcps.map(({ xyz, ...p }) => ({ ...p, coordinates: xyz })) }
      for (const path of Object.keys(docs)) {
        if (path.startsWith('products/') && docs[path]) docs[path] = { ...docs[path], kind: 'dem' }
      }
      docs['products/old.json'] = null
      docs['notes.json'] = { created: true }
      return docs
    },
  },
]

function makeProject() {
  const root = makeDir('p1')
  put(root, 'project.json', { name: 'P', images: [] })
  put(root, 'gcps.json', { gcps: [{ id: 'a', xyz: [1, 2, 3] }] })
  put(root, 'poses.json', { poses: [7] })
  const products = makeDir('products')
  root.dirs.set('products', products)
  put(products, 'dem.json', { width: 4 })
  put(products, 'old.json', { width: 2 })
  products.files.set('dem.json.g1.data.bin', { data: 'binary' })
  return root
}

// Every document's content, by path: what a finished migration leaves.
function snapshot(dir, prefix = '') {
  const out = {}
  for (const [n, f] of dir.files) out[prefix + n] = f.data
  for (const [n, d] of dir.dirs) Object.assign(out, snapshot(d, `${prefix}${n}/`))
  return out
}

async function openProject(root) {
  return migrateProjectFormat('p1', JSON.parse(root.files.get('project.json').data), { steps, to: 2 })
}

beforeEach(() => {
  writes = 0
  failAfter = Infinity
})

describe('migrateProjectFormat', () => {
  it('migrates the documents, keeps a copy of each and writes the version last', async () => {
    const root = makeProject()
    setProjectRoot('p1', root)
    try {
      const { data, notes } = await openProject(root)
      expect(data).toEqual({ name: 'P', images: [], formatVersion: 2 })
      expect(notes).toEqual(['format 1 → 2: test migration'])
      expect(get(root, 'project.json').formatVersion).toBe(2)
      expect(get(root, 'gcps.json').gcps[0]).toEqual({ id: 'a', coordinates: [1, 2, 3] })
      expect(get(root, 'notes.json')).toEqual({ created: true })
      const products = root.dirs.get('products')
      expect(get(products, 'dem.json')).toEqual({ width: 4, kind: 'dem' })
      expect(products.files.has('old.json')).toBe(false)
      expect(products.files.get('dem.json.g1.data.bin').data).toBe('binary') // binaries untouched
      // The copies undo it by hand; the list is gone once the migration finished.
      expect(get(root, 'gcps.json.v1.bak')).toEqual({ gcps: [{ id: 'a', xyz: [1, 2, 3] }] })
      expect(get(root, 'project.json.v1.bak')).toEqual({ name: 'P', images: [] })
      expect(get(products, 'old.json.v1.bak')).toEqual({ width: 2 })
      expect(root.files.has('format-migration.json')).toBe(false)
      expect(root.files.has('notes.json.v1.bak')).toBe(false) // it did not exist before
      expect(root.files.has('poses.json.v1.bak')).toBe(false) // not named by any step
    } finally {
      clearProjectRoot('p1')
    }
  })

  it('does nothing to a project in this version', async () => {
    const root = makeProject()
    setProjectRoot('p1', root)
    try {
      const before = snapshot(root)
      const data = { name: 'P', formatVersion: 2 }
      expect(await migrateProjectFormat('p1', data, { steps, to: 2 })).toEqual({ data, notes: [] })
      expect(snapshot(root)).toEqual(before)
    } finally {
      clearProjectRoot('p1')
    }
  })

  it('ends where an uninterrupted run ends, whichever write the tab died at', async () => {
    const clean = makeProject()
    setProjectRoot('p1', clean)
    await openProject(clean)
    const expected = snapshot(clean)
    const total = writes
    expect(total).toBeGreaterThan(5)
    for (let k = 0; k < total; k++) {
      const root = makeProject()
      setProjectRoot('p1', root)
      writes = 0
      failAfter = k
      await expect(openProject(root)).rejects.toThrow('tab killed')
      // The next open reads project.json again: still version 1 until the last write.
      expect(get(root, 'project.json').formatVersion).toBeUndefined()
      writes = 0
      failAfter = Infinity
      await openProject(root)
      expect(snapshot(root), `killed after ${k} writes`).toEqual(expected)
    }
    clearProjectRoot('p1')
  })

  it('refuses a version it has no step from', async () => {
    const root = makeProject()
    setProjectRoot('p1', root)
    try {
      await expect(migrateProjectFormat('p1', { formatVersion: 1 }, { steps: [], to: 2 })).rejects.toThrow(
        /no format migration from version 1/,
      )
      expect(root.files.has('format-migration.json')).toBe(false)
    } finally {
      clearProjectRoot('p1')
    }
  })
})

describe('archives', () => {
  it('leave out what a migration kept', () => {
    expect(shouldArchivePath('gcps.json.v1.bak')).toBe(false)
    expect(shouldArchivePath('products/dem.json.v12.bak')).toBe(false)
    expect(shouldArchivePath('format-migration.json')).toBe(false)
    expect(shouldArchivePath('gcps.json')).toBe(true)
    expect(shouldArchivePath('images/v1.bak.jpg')).toBe(true)
  })
})

import { describe, it, expect, beforeEach, vi } from 'vitest'

// A fake OPFS: relPath → Blob, exactly the surface projectFile.js uses. Keeping
// it at the module boundary (rather than faking FileSystemDirectoryHandle) is
// deliberate — the walk/write semantics are what matter here, and the real
// handle API only exists in a browser.
const store = new Map()
// Test hooks: `onGetFile(relPath)` runs inside a walked handle's getFile (a save landing
// mid-export), `fileOverride(relPath, attempt)` may hand back a different snapshot.
const hooks = { onGetFile: null, fileOverride: null }
const notFound = (relPath) => Object.assign(new Error(`${relPath} not found`), { name: 'NotFoundError' })

// The binary-document lock, as persistenceLock's fallback queue.
const locks = new Map()
function lock(key, work) {
  const run = (locks.get(key) ?? Promise.resolve()).then(work, work)
  locks.set(
    key,
    run.then(
      () => {},
      () => {},
    ),
  )
  return run
}

vi.mock('./opfs.js', async () => {
  const real = await vi.importActual('./opfs.js')
  return {
    binaryDocumentLockKey: real.binaryDocumentLockKey,
    binaryDocumentOf: real.binaryDocumentOf,
    withBinaryDocumentLock: (projectId, relPath, work) => lock(real.binaryDocumentLockKey(projectId, relPath), work),
    async getProjectFile(_projectId, relPath) {
      return store.get(relPath) ?? null
    },
    async *walkProjectFiles(_projectId, { skip = null } = {}) {
      for (const [relPath, blob] of [...store]) {
        // Mirror the real prune: `skip` is consulted per directory, so a skipped
        // directory removes its whole subtree.
        const parts = relPath.split('/')
        let pruned = false
        for (let i = 1; i < parts.length; i++) {
          if (skip?.(parts.slice(0, i).join('/'), 'directory')) {
            pruned = true
            break
          }
        }
        if (pruned || skip?.(relPath, 'file')) continue
        let attempt = 0
        const handle = {
          async getFile() {
            await hooks.onGetFile?.(relPath)
            const override = hooks.fileOverride?.(relPath, attempt++)
            if (override) return override
            if (!store.has(relPath)) throw notFound(relPath)
            return store.get(relPath)
          },
        }
        yield { relPath, file: blob, handle }
      }
    },
    async writeProjectFile(_projectId, relPath, data) {
      store.set(relPath, new Blob([data]))
    },
    async getQuota() {
      return { quota: 10 * 1024 * 1024 * 1024, usage: 0 }
    },
  }
})

const { exportProjectArchive, importProjectArchive, peekArchiveManifest } = await import('./projectFile.js')
const { buildManifest, MANIFEST_NAME } = await import('../core/io/projectArchive.js')
const { zipStore } = await import('./zip.js')

// Collect the archive in memory instead of opening a save dialog.
function memorySink() {
  const chunks = []
  return {
    sink: () => ({
      streaming: false,
      write: (c) => {
        chunks.push(c.slice())
      },
      close: async () => {},
      abort: () => {
        chunks.length = 0
      },
    }),
    blob: () => new Blob(chunks),
  }
}

function bytes(...values) {
  return new Uint8Array(values)
}

const MANIFEST = buildManifest({
  project: { name: 'Ross Ice Shelf', sceneType: 'aerial', crs: 'EPSG:3031', createdAt: '2026-01-01T00:00:00.000Z' },
})

function seedProject() {
  store.clear()
  store.set(
    'project.json',
    new Blob([JSON.stringify({ id: 'old-id', name: 'Ross Ice Shelf', images: [{ uuid: 'img-1' }] })]),
  )
  store.set('gcps.json', new Blob([JSON.stringify({ crs: 'EPSG:3031', gcps: [{ id: 'g1', x: 1, y: 2, z: 3 }] })]))
  // Binary sidecars: float payloads must survive byte-exact, which is the point
  // of storing (not deflating) them.
  store.set('recon.c1.pos.bin', new Blob([new Float64Array([1.5, -2.25, 1e6]).buffer]))
  store.set('images/img-1', new Blob([bytes(0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 7)]))
  store.set('images-derived/img-1.display', new Blob([bytes(1, 2, 3, 4)]))
  store.set('depthmaps/index.json', new Blob([JSON.stringify({ version: 1, maps: [] })]))
  store.set('log.ndjson', new Blob(['{"message":"noise"}\n']))
}

async function snapshot() {
  const out = new Map()
  for (const [k, v] of store) out.set(k, new Uint8Array(await v.arrayBuffer()))
  return out
}

async function roundTrip(includeDerived = true) {
  seedProject()
  const before = await snapshot()
  const { sink, blob } = memorySink()
  const res = await exportProjectArchive({
    projectId: 'src',
    manifest: MANIFEST,
    fileName: 'p.websfm',
    includeDerived,
    openSink: sink,
  })
  const archive = blob()
  store.clear()
  const imported = await importProjectArchive({ file: archive, projectId: 'dst' })
  return { before, after: await snapshot(), res, imported, archive }
}

beforeEach(() => {
  store.clear()
  hooks.onGetFile = null
  hooks.fileOverride = null
})

describe('project archive round trip', () => {
  it('restores every archived file byte-for-byte', async () => {
    const { before, after } = await roundTrip()
    const expected = [...before.keys()].filter((k) => k !== 'log.ndjson').sort()
    expect([...after.keys()].sort()).toEqual(expected)
    for (const key of expected) expect(after.get(key), key).toEqual(before.get(key))
  })

  it('never carries the session log', async () => {
    const { after } = await roundTrip()
    expect(after.has('log.ndjson')).toBe(false)
  })

  it('reports the manifest it read back', async () => {
    const { imported } = await roundTrip()
    expect(imported.manifest).toEqual(MANIFEST)
    expect(imported.entryCount).toBe(6) // 7 seeded files − log.ndjson
  })

  it('excludes only the derived trees when asked, and stays loadable', async () => {
    const { after } = await roundTrip(false)
    expect(after.has('images-derived/img-1.display')).toBe(false)
    expect(after.has('depthmaps/index.json')).toBe(false)
    // The project itself is intact — that is what makes dropping them safe.
    expect(after.has('project.json')).toBe(true)
    expect(after.has('images/img-1')).toBe(true)
    expect(JSON.parse(new TextDecoder().decode(after.get('project.json'))).name).toBe('Ross Ice Shelf')
  })

  it('writes the manifest first so it can be peeked without unpacking', async () => {
    const { archive } = await roundTrip()
    expect(await peekArchiveManifest(archive)).toEqual(MANIFEST)
  })

  it('the manifest is not written into the project tree', async () => {
    const { after } = await roundTrip()
    expect(after.has(MANIFEST_NAME)).toBe(false)
  })
})

describe('peekArchiveManifest', () => {
  it('returns null for a non-zip', async () => {
    expect(await peekArchiveManifest(new Blob(['not a zip at all']))).toBe(null)
  })

  it('returns null for a zip that is not a project (e.g. a COLMAP model)', async () => {
    // Built with the independent STORE writer in utils/zip.js, so this is a real
    // foreign archive rather than one of ours with a field removed.
    const enc = new TextEncoder()
    const colmap = zipStore([
      { name: 'cameras.txt', data: enc.encode('1 PINHOLE 100 100 50 50 50 50\n') },
      { name: 'images.txt', data: enc.encode('') },
    ])
    expect(await peekArchiveManifest(new Blob([colmap]))).toBe(null)
  })
})

describe('importProjectArchive', () => {
  // The *store* rejects such a file up front via peekArchiveManifest, before any
  // project dir exists; this is the belt-and-braces check on the unpack itself
  // (whose caller deletes the half-written dir).
  it('rejects an archive with no manifest', async () => {
    const enc = new TextEncoder()
    const foreign = zipStore([{ name: 'project.json', data: enc.encode('{}') }])
    store.clear()
    await expect(importProjectArchive({ file: new Blob([foreign]), projectId: 'dst' })).rejects.toThrow(/manifest/)
  })

  it('refuses path-traversal entry names', async () => {
    seedProject()
    store.set('../escape.txt', new Blob(['nope']))
    const { sink, blob } = memorySink()
    await exportProjectArchive({ projectId: 'src', manifest: MANIFEST, fileName: 'p.websfm', openSink: sink })
    const archive = blob()
    store.clear()
    const warnings = []
    await importProjectArchive({
      file: archive,
      projectId: 'dst',
      onLog: (m, level) => warnings.push([level, m]),
    })
    expect(store.has('../escape.txt')).toBe(false)
    expect(warnings.some(([level, m]) => level === 'warn' && /unsafe paths/.test(m))).toBe(true)
  })

  it('rejects archives whose expanded content exceeds the import budget', async () => {
    seedProject()
    const { sink, blob } = memorySink()
    await exportProjectArchive({ projectId: 'src', manifest: MANIFEST, fileName: 'p.websfm', openSink: sink })
    store.clear()
    await expect(
      importProjectArchive({
        file: blob(),
        projectId: 'dst',
        limits: { maxTotalBytes: 16 },
      }),
    ).rejects.toThrow(/beyond the .* available/)
  })
})

// Project files saved before the ZIP64 writer came from fflate's streaming Zip: data
// descriptors after each entry, deflated JSON, stored binaries. They must still open.
describe('projects saved by the earlier fflate writer', () => {
  it('import and peek read them through the central directory', async () => {
    const { Zip, ZipDeflate, ZipPassThrough } = await import('fflate')
    const parts = []
    const zip = new Zip((err, chunk) => {
      if (err) throw err
      if (chunk) parts.push(chunk.slice())
    })
    const add = (name, data, deflate) => {
      const e = deflate ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name)
      zip.add(e)
      e.push(data, true)
    }
    const enc = new TextEncoder()
    add(MANIFEST_NAME, enc.encode(JSON.stringify(MANIFEST)), true)
    add('project.json', enc.encode(JSON.stringify({ id: 'x', name: 'Old' })), true)
    add('recon.c1.pos.bin', new Uint8Array(new Float64Array([1.5, -2.25]).buffer), false)
    zip.end()
    const file = new Blob(parts)
    expect(await peekArchiveManifest(file)).toEqual(MANIFEST)
    store.clear()
    const r = await importProjectArchive({ file, projectId: 'dst' })
    expect(r.entryCount).toBe(2)
    expect(JSON.parse(await store.get('project.json').text())).toEqual({ id: 'x', name: 'Old' })
    expect([...new Float64Array(await store.get('recon.c1.pos.bin').arrayBuffer())]).toEqual([1.5, -2.25])
  })
})

// A binary document (binaryDocument.js) as the store saves it: the generation files,
// then the metadata naming them, then the old generation collected — under its lock.
async function saveReconstruction(generation, values) {
  await lock('reconstruction:src', async () => {
    const name = `reconstruction.json.${generation}.c1.pos.bin`
    const buffer = new Float64Array(values).buffer
    store.set(name, new Blob([buffer]))
    store.set(
      'reconstruction.json',
      new Blob([
        JSON.stringify({
          version: 3,
          clouds: [{ id: 'c1', kind: 'sparse', pointCount: values.length / 3 }],
          binaryFiles: { 'c1.pos': { name, bytes: buffer.byteLength } },
        }),
      ]),
    )
    for (const key of [...store.keys()]) {
      if (key.startsWith('reconstruction.json.') && key !== name) store.delete(key)
    }
  })
}

// The reconstruction an opened archive holds: its metadata and the buffers it names.
function reopenedModel() {
  return (async () => {
    const meta = JSON.parse(await store.get('reconstruction.json').text())
    const buffers = {}
    for (const [key, f] of Object.entries(meta.binaryFiles)) {
      const blob = store.get(f.name)
      if (!blob || blob.size !== f.bytes) throw new Error(`Incomplete saved buffer: ${key}`)
      buffers[key] = [...new Float64Array(await blob.arrayBuffer())]
    }
    return buffers
  })()
}

async function exportAndReopen(opts = {}) {
  const { sink, blob } = memorySink()
  const logs = []
  await exportProjectArchive({
    projectId: 'src',
    manifest: MANIFEST,
    fileName: 'p.websfm',
    openSink: sink,
    onLog: (m, level) => logs.push([level, m]),
    ...opts,
  })
  store.clear()
  await importProjectArchive({ file: blob(), projectId: 'dst' })
  return logs
}

describe('saving a busy project', () => {
  it('a save landing mid-export still archives one complete generation of the model', async () => {
    seedProject()
    await saveReconstruction('genA', [1, 2, 3])
    // While the photos are archived (they sort before reconstruction.json), the project
    // saves its model again: generation B is committed and A collected.
    hooks.onGetFile = async (relPath) => {
      if (relPath !== 'images/img-1') return
      hooks.onGetFile = null
      await saveReconstruction('genB', [4, 5, 6, 7, 8, 9])
    }
    await exportAndReopen()
    expect(await reopenedModel()).toEqual({ 'c1.pos': [4, 5, 6, 7, 8, 9] })
    expect([...store.keys()].filter((k) => k.startsWith('reconstruction.json.'))).toEqual([
      'reconstruction.json.genB.c1.pos.bin',
    ])
  })

  it('a save that starts while the model is being archived waits for it', async () => {
    seedProject()
    await saveReconstruction('genA', [1, 2, 3])
    let pending = null
    const real = store.get('reconstruction.json')
    // The archive reads the metadata under the document's lock; a save queued then
    // commits after, so the archive holds generation A, whole.
    class SaveOnRead extends Blob {
      arrayBuffer() {
        pending ??= saveReconstruction('genB', [7, 8, 9])
        return super.arrayBuffer()
      }
    }
    store.set('reconstruction.json', new SaveOnRead([real]))
    await exportAndReopen()
    await pending
    expect(await reopenedModel()).toEqual({ 'c1.pos': [1, 2, 3] })
  })

  it('a large file rewritten before its bytes are written is read again from a fresh snapshot', async () => {
    seedProject()
    const big = new Uint8Array(64 * 1024 * 1024 + 7).map((_, i) => i % 251)
    store.set('lod/c1.lod', new Blob([big]))
    const stale = Object.assign(new Error('The requested file could not be read'), { name: 'NotReadableError' })
    class StaleSnapshot extends Blob {
      slice() {
        return { arrayBuffer: () => Promise.reject(stale) }
      }
    }
    hooks.fileOverride = (relPath, attempt) =>
      relPath === 'lod/c1.lod' && attempt === 0 ? new StaleSnapshot([big]) : null
    await exportAndReopen()
    const back = new Uint8Array(await store.get('lod/c1.lod').arrayBuffer())
    expect(back.length).toBe(big.length)
    expect(back[12345]).toBe(big[12345])
    expect(back[big.length - 1]).toBe(big[big.length - 1])
  }, 30_000)

  it('a large file rewritten part-way through its bytes fails the save and says why', async () => {
    seedProject()
    const big = new Uint8Array(64 * 1024 * 1024 + 7)
    store.set('lod/c1.lod', new Blob([big]))
    const stale = Object.assign(new Error('The requested file could not be read'), { name: 'NotReadableError' })
    class Rewritten extends Blob {
      stream() {
        return new ReadableStream({ pull: (c) => c.error(stale) })
      }
    }
    hooks.fileOverride = (relPath) => (relPath === 'lod/c1.lod' ? new Rewritten([big]) : null)
    const { sink } = memorySink()
    await expect(
      exportProjectArchive({ projectId: 'src', manifest: MANIFEST, fileName: 'p.websfm', openSink: sink }),
    ).rejects.toThrow(/lod\/c1\.lod was rewritten while the project was being saved/)
  }, 30_000)
})

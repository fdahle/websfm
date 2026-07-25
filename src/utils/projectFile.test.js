import { describe, it, expect, beforeEach, vi } from 'vitest'

// A fake OPFS: relPath → Blob, exactly the surface projectFile.js uses. Keeping
// it at the module boundary (rather than faking FileSystemDirectoryHandle) is
// deliberate — the walk/write semantics are what matter here, and the real
// handle API only exists in a browser.
const store = new Map()

vi.mock('./opfs.js', () => ({
  async *walkProjectFiles(_projectId, { skip = null } = {}) {
    for (const [relPath, blob] of store) {
      // Mirror the real prune: `skip` is consulted per directory, so a skipped
      // directory removes its whole subtree.
      const parts = relPath.split('/')
      let pruned = false
      for (let i = 1; i < parts.length; i++) {
        if (skip?.(parts.slice(0, i).join('/'), 'directory')) { pruned = true; break }
      }
      if (pruned || skip?.(relPath, 'file')) continue
      yield { relPath, file: blob }
    }
  },
  async writeProjectFile(_projectId, relPath, data) {
    store.set(relPath, new Blob([data]))
  },
  async getQuota() { return { quota: 10 * 1024 * 1024 * 1024, usage: 0 } },
}))

const { exportProjectArchive, importProjectArchive, peekArchiveManifest } = await import('./projectFile.js')
const { buildManifest, MANIFEST_NAME } = await import('../core/io/projectArchive.js')
const { zipStore } = await import('./zip.js')

// Collect the archive in memory instead of opening a save dialog.
function memorySink() {
  const chunks = []
  return {
    sink: () => ({
      streaming: false,
      write: (c) => { chunks.push(c.slice()) },
      close: async () => {},
      abort: () => { chunks.length = 0 },
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
  store.set('project.json', new Blob([JSON.stringify({ id: 'old-id', name: 'Ross Ice Shelf', images: [{ uuid: 'img-1' }] })]))
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
    projectId: 'src', manifest: MANIFEST, fileName: 'p.websfm', includeDerived, openSink: sink,
  })
  const archive = blob()
  store.clear()
  const imported = await importProjectArchive({ file: archive, projectId: 'dst' })
  return { before, after: await snapshot(), res, imported, archive }
}

beforeEach(() => store.clear())

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
    expect(imported.entryCount).toBe(6)   // 7 seeded files − log.ndjson
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
    await expect(importProjectArchive({ file: new Blob([foreign]), projectId: 'dst' }))
      .rejects.toThrow(/manifest/)
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
      file: archive, projectId: 'dst', onLog: (m, level) => warnings.push([level, m]),
    })
    expect(store.has('../escape.txt')).toBe(false)
    expect(warnings.some(([level, m]) => level === 'warn' && /unsafe paths/.test(m))).toBe(true)
  })

  it('rejects archives whose expanded content exceeds the import budget', async () => {
    seedProject()
    const { sink, blob } = memorySink()
    await exportProjectArchive({ projectId: 'src', manifest: MANIFEST, fileName: 'p.websfm', openSink: sink })
    store.clear()
    await expect(importProjectArchive({
      file: blob(), projectId: 'dst', limits: { maxTotalBytes: 16 },
    })).rejects.toThrow(/import limit/)
  })
})

import { describe, it, expect, vi, beforeEach } from 'vitest'
import * as opfs from './opfs.js'

// A minimal in-memory File System Access backend that reproduces the behaviour
// this module's write queue exists for: Chromium stages a createWritable() in a
// sibling `<name>.crswap` file, so a SECOND writable on the same file collides on
// that name and throws. Reported from a folder-backed project (2026-08-18), where
// real-disk latency widens the window OPFS usually wins by luck.
const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

function makeFile(name) {
  return {
    name,
    data: '',
    open: 0,
    async getFile() {
      const { data } = this
      return {
        size: data.length,
        text: async () => data,
        slice: (start = 0) => ({ text: async () => data.slice(start) }),
      }
    },
    async createWritable(opts) {
      if (this.open > 0) {
        throw new Error("Failed to execute 'createWritable' on 'FileSystemHandle': " + 'Failed to create swap file.')
      }
      this.open++
      const handle = this
      let buf = opts?.keepExistingData ? this.data : ''
      let pos = 0
      return {
        async seek(p) {
          await tick()
          pos = p
        },
        async write(chunk) {
          await tick()
          buf = buf.slice(0, pos) + String(chunk)
          pos = buf.length
        },
        async close() {
          await tick()
          handle.data = buf
          handle.open--
        },
      }
    },
  }
}

function makeDir(name) {
  const files = new Map()
  const dirs = new Map()
  return {
    name,
    files,
    dirs,
    async getDirectoryHandle(n, opts) {
      if (!dirs.has(n)) {
        if (!opts?.create) throw new Error(`no dir ${n}`)
        dirs.set(n, makeDir(n))
      }
      return dirs.get(n)
    },
    async getFileHandle(n, opts) {
      if (!files.has(n)) {
        if (!opts?.create) throw new Error(`no file ${n}`)
        files.set(n, makeFile(n))
      }
      return files.get(n)
    },
    async removeEntry(n) {
      files.delete(n)
      dirs.delete(n)
    },
  }
}

let root
const projectDir = (id) => root.dirs.get('websfm').dirs.get('projects').dirs.get(id)

beforeEach(() => {
  root = makeDir('')
  vi.stubGlobal('navigator', { storage: { getDirectory: async () => root } })
})

describe('write serialization', () => {
  it('survives concurrent writes to the same file', async () => {
    // Without the queue this rejects with "Failed to create swap file" — the
    // production symptom, reached from usePosesStore.save racing itself during
    // an EXIF-GPS sync.
    await Promise.all([
      opfs.savePoses('p1', { crs: 'EPSG:4326', poses: [1] }),
      opfs.savePoses('p1', { crs: 'EPSG:4326', poses: [1, 2] }),
      opfs.savePoses('p1', { crs: 'EPSG:4326', poses: [1, 2, 3] }),
    ])
    const written = JSON.parse(projectDir('p1').files.get('poses.json').data)
    // Last writer wins, and the file is complete JSON rather than interleaved.
    expect(written.poses).toEqual([1, 2, 3])
  })

  it('keeps a failed write from cancelling the ones queued behind it', async () => {
    await opfs.savePoses('p2', { poses: [] })
    const fh = projectDir('p2').files.get('poses.json')
    const realCreate = fh.createWritable.bind(fh)
    let first = true
    fh.createWritable = async function (opts) {
      if (first) {
        first = false
        throw new Error('disk full')
      }
      return realCreate(opts)
    }

    const results = await Promise.allSettled([
      opfs.savePoses('p2', { poses: ['doomed'] }),
      opfs.savePoses('p2', { poses: ['survivor'] }),
    ])
    expect(results[0].status).toBe('rejected')
    expect(results[1].status).toBe('fulfilled')
    expect(JSON.parse(fh.data).poses).toEqual(['survivor'])
  })

  it('says storage is full when a write exceeds the quota, and passes other errors through', async () => {
    await opfs.savePoses('p3', { poses: [] })
    const fh = projectDir('p3').files.get('poses.json')
    const fail = (name, message) => {
      fh.createWritable = async () => {
        throw Object.assign(new Error(message), { name })
      }
    }
    fail(
      'QuotaExceededError',
      'The operation failed because it would cause the application to exceed its storage quota.',
    )
    const err = await opfs.savePoses('p3', { poses: [1] }).catch((e) => e)
    expect(opfs.isStorageFull(err)).toBe(true)
    expect(err.message).toMatch(
      /^Storage is full: the browser or the disk refused to save project data\. Free space .*\(poses\.json\)$/,
    )
    expect(err.cause.message).toMatch(/storage quota/)
    fail('NotAllowedError', 'denied')
    const other = await opfs.savePoses('p3', { poses: [2] }).catch((e) => e)
    expect(opfs.isStorageFull(other)).toBe(false)
    expect(other.message).toBe('denied')
    // A quota hit part-way through a write: Chromium says AbortError "Failed to write
    // data to data pipe", while the estimate still shows space.
    navigator.storage.estimate = async () => ({ usage: 1e6, quota: 100e9 })
    fail('AbortError', 'Failed to write data to data pipe')
    expect(opfs.isStorageFull(await opfs.savePoses('p3', { poses: [3] }).catch((e) => e))).toBe(true)
    // Any other aborted write passes through, unless the space left is below the write.
    fail('AbortError', 'The user aborted a request.')
    const aborted = await opfs.savePoses('p3', { poses: [4] }).catch((e) => e)
    expect(opfs.isStorageFull(aborted)).toBe(false)
    expect(aborted.message).toBe('The user aborted a request.')
    navigator.storage.estimate = async () => ({ usage: 99.5e6, quota: 100e6 })
    expect(opfs.isStorageFull(await opfs.savePoses('p3', { poses: [5] }).catch((e) => e))).toBe(true)
  })

  it('does not serialize unrelated files', async () => {
    await Promise.all([opfs.savePoses('p3', { poses: [1] }), opfs.saveGcps('p3', [{ id: 'g1' }])])
    expect(JSON.parse(projectDir('p3').files.get('poses.json').data).poses).toEqual([1])
    expect(JSON.parse(projectDir('p3').files.get('gcps.json').data)).toEqual([{ id: 'g1' }])
  })

  it('appends without losing a concurrent entry', async () => {
    // The offset is read inside the lock: reading it outside would give both
    // appends the same start and one would overwrite the other.
    await Promise.all([opfs.appendLog('p4', [{ m: 'a' }]), opfs.appendLog('p4', [{ m: 'b' }])])
    const lines = projectDir('p4').files.get('log.ndjson').data.trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).m).sort()).toEqual(['a', 'b'])
  })

  it('reads only the requested tail of a large log', async () => {
    const entries = Array.from({ length: 3000 }, (_, i) => ({ i, m: 'x'.repeat(40) }))
    await opfs.appendLog('p5', entries)
    const tail = await opfs.readLogTail('p5', 25)
    expect(tail).toHaveLength(25)
    expect(tail[0].i).toBe(2975)
    expect(tail[24].i).toBe(2999)
  })

  it('round-trips and deletes project workflows', async () => {
    const data = {
      workflows: [{ id: 'w1', name: 'Survey recipe', blocks: [] }],
      activeId: 'w1',
      runs: [],
    }

    await opfs.saveWorkflows('p6', data)
    expect(await opfs.loadWorkflows('p6')).toEqual(data)

    await opfs.deleteWorkflows('p6')
    expect(await opfs.loadWorkflows('p6')).toBeNull()
  })
})

// The .websfm save archives each binary document under the lock its saves hold.
describe('binary documents as one unit', () => {
  it("names each document by its metadata path and its saves' lock", () => {
    expect(opfs.binaryDocumentLockKey('p', 'reconstruction.json')).toBe('reconstruction:p')
    expect(opfs.binaryDocumentLockKey('p', 'matches/matches.json')).toBe('matches:p')
    expect(opfs.binaryDocumentLockKey('p', 'products/ortho.json')).toBe('product:p:ortho')
    expect(opfs.binaryDocumentLockKey('p', 'project.json')).toBeNull()
    expect(opfs.binaryDocumentLockKey('p', 'depthmaps/index.json')).toBeNull()
  })

  it('maps a generation file to its document, and nothing else', () => {
    expect(opfs.binaryDocumentOf('reconstruction.json.0f3a.cloud.1.pos.bin')).toBe('reconstruction.json')
    expect(opfs.binaryDocumentOf('matches/matches.json.0f3a.matches.bin')).toBe('matches/matches.json')
    expect(opfs.binaryDocumentOf('products/dem.json.0f3a.data.bin')).toBe('products/dem.json')
    expect(opfs.binaryDocumentOf('products/dem_data.bin')).toBeNull()
    expect(opfs.binaryDocumentOf('depthmaps/abc.depth.bin')).toBeNull()
    expect(opfs.binaryDocumentOf('reconstruction.json')).toBeNull()
  })
})

describe('tree walks during writes', () => {
  const file = (size) => ({ kind: 'file', getFile: async () => ({ size }) })
  const gone = {
    kind: 'file',
    getFile: async () => {
      throw Object.assign(new Error('A requested file or directory could not be found'), { name: 'NotFoundError' })
    },
  }
  const dir = (entries) => ({
    kind: 'directory',
    async *[Symbol.asyncIterator]() {
      yield* Object.entries(entries)
    },
  })

  it("leaves out a write's swap file and a file removed while it walks", async () => {
    const tree = dir({
      'project.json': file(10),
      'log.ndjson.crswap': file(5),
      'removed.bin': gone,
      'images': dir({ 'a.jpg': file(100), 'a.jpg.crswap': file(40) }),
    })
    expect(await opfs.measureTree(tree)).toEqual({ files: 2, bytes: 110 })
    expect(await opfs.measureTree(tree, { skip: (p) => p === 'project.json' })).toEqual({ files: 1, bytes: 100 })
  })
})

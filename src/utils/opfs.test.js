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
      return { size: data.length, text: async () => data }
    },
    async createWritable(opts) {
      if (this.open > 0) {
        throw new Error("Failed to execute 'createWritable' on 'FileSystemHandle': "
          + 'Failed to create swap file.')
      }
      this.open++
      const handle = this
      let buf = opts?.keepExistingData ? this.data : ''
      let pos = 0
      return {
        async seek(p) { await tick(); pos = p },
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
    name, files, dirs,
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
    async removeEntry(n) { files.delete(n); dirs.delete(n) },
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
      if (first) { first = false; throw new Error('disk full') }
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

  it('does not serialize unrelated files', async () => {
    await Promise.all([
      opfs.savePoses('p3', { poses: [1] }),
      opfs.saveGcps('p3', [{ id: 'g1' }]),
    ])
    expect(JSON.parse(projectDir('p3').files.get('poses.json').data).poses).toEqual([1])
    expect(JSON.parse(projectDir('p3').files.get('gcps.json').data)).toEqual([{ id: 'g1' }])
  })

  it('appends without losing a concurrent entry', async () => {
    // The offset is read inside the lock: reading it outside would give both
    // appends the same start and one would overwrite the other.
    await Promise.all([
      opfs.appendLog('p4', [{ m: 'a' }]),
      opfs.appendLog('p4', [{ m: 'b' }]),
    ])
    const lines = projectDir('p4').files.get('log.ndjson').data.trim().split('\n')
    expect(lines.map((l) => JSON.parse(l).m).sort()).toEqual(['a', 'b'])
  })
})

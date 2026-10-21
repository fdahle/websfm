import { describe, it, expect } from 'vitest'
import { createRevision } from './revision.js'

function deferred() {
  let resolve
  const promise = new Promise((r) => {
    resolve = r
  })
  return { promise, resolve }
}

// A model of ViewerImage's mask canvas, using the revision exactly as the viewer
// does: a decode bumps before awaiting (it replaces the canvas), an export captures
// the current revision (it reads the canvas), a sync edit bumps. `canvas` is the
// state shown, `store` what was persisted. Decodes/exports are controllable.
function maskModel() {
  const rev = createRevision()
  const m = { canvas: null, store: null, pendingDecodes: [], pendingExports: [] }
  m.edit = (state) => {
    rev.bump()
    m.canvas = state
  }
  m.clear = () => {
    rev.bump()
    m.canvas = null
  }
  m.load = async (blob) => {
    const t = rev.bump()
    const d = deferred()
    m.pendingDecodes.push(d)
    const bmp = await d.promise
    if (!rev.isCurrent(t)) return false
    m.canvas = bmp
    return true
  }
  m.export = async () => {
    const t = rev.current()
    const snapshot = m.canvas // convertToBlob snapshots the canvas at call time
    const d = deferred()
    m.pendingExports.push(d)
    await d.promise
    if (!rev.isCurrent(t)) return false
    m.store = snapshot
    return true
  }
  // applyMaskSnapshot: decode the blob (or clear), and persist it.
  m.restore = (blob) => {
    const p = blob ? m.load(blob) : (m.clear(), Promise.resolve(true))
    m.store = blob
    return p
  }
  return m
}

const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createRevision', () => {
  it('only the latest token is current', () => {
    const r = createRevision()
    const a = r.bump()
    expect(r.isCurrent(a)).toBe(true)
    const b = r.bump()
    expect(r.isCurrent(a)).toBe(false)
    expect(r.isCurrent(b)).toBe(true)
    expect(r.current()).toBe(b)
  })

  it('case A — two quick undos (B → A → none): the late decode of A is dropped', async () => {
    const m = maskModel()
    m.canvas = 'B'
    m.store = 'B'
    const undo1 = m.restore('A') // decode of A pending
    const undo2 = m.restore(null) // canvas cleared for "none"
    expect(m.canvas).toBeNull()
    m.pendingDecodes[0].resolve('A') // A's decode lands late
    expect(await undo1).toBe(false)
    await undo2
    expect(m.canvas).toBeNull() // not repainted with A
    expect(m.store).toBeNull()
  })

  it('case B — undo while a stroke is encoding: the pending export does not revert the undo', async () => {
    const m = maskModel()
    m.canvas = 'X'
    m.store = 'X'
    m.edit('X+stroke')
    const exp = m.export() // stroke's PNG encode pending
    const undo = m.restore('X') // Ctrl+Z
    m.pendingDecodes[0].resolve('X')
    await undo
    m.pendingExports[0].resolve() // the stroke's blob lands now
    expect(await exp).toBe(false)
    expect(m.store).toBe('X')
    expect(m.canvas).toBe('X')
  })

  it('an export with no later mutation is persisted', async () => {
    const m = maskModel()
    m.edit('S1')
    const exp = m.export()
    await flush()
    m.pendingExports[0].resolve()
    expect(await exp).toBe(true)
    expect(m.store).toBe('S1')
  })

  it('a newer stroke supersedes an older pending export, and its own export carries both', async () => {
    const m = maskModel()
    m.edit('S1')
    const e1 = m.export()
    m.edit('S1+S2')
    const e2 = m.export()
    m.pendingExports[1].resolve()
    m.pendingExports[0].resolve() // older encode finishing last must not win
    expect(await e2).toBe(true)
    expect(await e1).toBe(false)
    expect(m.store).toBe('S1+S2')
  })
})

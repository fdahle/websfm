// Client for workers/copcNode.worker.js: the 3D view's COPC node reads, off the main
// thread. Two lazily spawned workers, round robin (the view keeps a few loads in
// flight). A worker crash rejects what it held; the next request spawns a fresh one.

const POOL = 2
const workers = new Array(POOL).fill(null)
let rr = 0
let nextId = 1
const pending = new Map()

function spawn(slot) {
  const w = new Worker(new URL('./copcNode.worker.js', import.meta.url), { type: 'module', name: 'copc-node' })
  w.onmessage = (e) => {
    const { id, ok, result, error } = e.data
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    if (ok) entry.resolve(result)
    else entry.reject(new Error(error))
  }
  w.onerror = (e) => {
    const err = new Error(e.message || 'COPC node worker error')
    for (const [id, entry] of pending)
      if (entry.worker === w) {
        pending.delete(id)
        entry.reject(err)
      }
    w.terminate()
    if (workers[slot] === w) workers[slot] = null
  }
  return w
}

/**
 * One node of a COPC cloud: data (the file), node { offset, length, count }, lod (the
 * cloud's `lod` metadata, format 'copc'), as 'render' | 'absolute'.
 * → { count, pos, col, attributes }
 */
export function readCopcNode(data, node, lod, as = 'render') {
  if (typeof Worker === 'undefined') return Promise.reject(new Error('COPC node reads need a Worker'))
  const slot = rr++ % POOL
  const worker = (workers[slot] ??= spawn(slot))
  const id = nextId++
  // Only what the decode needs: the layout and the file's record description.
  const meta = { layout: lod.layout, copc: lod.copc }
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, worker })
    try {
      worker.postMessage({
        id,
        data,
        node: { offset: node.offset, length: node.length, count: node.count },
        lod: meta,
        as,
      })
    } catch (err) {
      pending.delete(id)
      reject(err)
    }
  })
}

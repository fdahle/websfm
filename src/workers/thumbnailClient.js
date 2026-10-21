// Client for workers/thumbnail.worker.js: one lazily-spawned worker, promise per
// request. Concurrency is the caller's (useImagesStore's thumbnail queue), so this
// stays a plain request/response pipe. A worker crash rejects what it held and the
// next request spawns a fresh one.

let worker = null
let nextId = 1
const pending = new Map()

function spawn() {
  const w = new Worker(new URL('./thumbnail.worker.js', import.meta.url), { type: 'module', name: 'thumbnail' })
  w.onmessage = (e) => {
    const { id, ok, result, error } = e.data
    const entry = pending.get(id)
    if (!entry) return
    pending.delete(id)
    if (ok) entry.resolve(result)
    else entry.reject(new Error(error))
  }
  w.onerror = (e) => {
    const err = new Error(e.message || 'thumbnail worker error')
    for (const [id, entry] of pending) {
      pending.delete(id)
      entry.reject(err)
    }
    w.terminate()
    if (worker === w) worker = null
  }
  return w
}

// source: a Blob/File or a blob: URL. opts: { maxDim, quality, hint: { width, height } }.
export function makeThumbnail(source, opts = {}) {
  if (typeof Worker === 'undefined') return Promise.reject(new Error('thumbnails need a Worker'))
  worker ??= spawn()
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try {
      worker.postMessage({ id, source, opts })
    } catch (err) {
      pending.delete(id)
      reject(err)
    }
  })
}

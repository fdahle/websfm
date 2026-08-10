// One modal-scoped COLMAP SQLite session. `dispose()` terminates the worker and
// releases the uploaded database even if SQLite cannot unlink its temporary VFS file.
let worker = null
let nextId = 1
const pending = new Map()

function getWorker() {
  if (worker) return worker
  worker = new Worker(new URL('./colmapDb.worker.js', import.meta.url), { type: 'module', name: 'colmap-database' })
  worker.onmessage = ({ data }) => {
    const p = pending.get(data.id)
    if (!p) return
    pending.delete(data.id)
    data.ok ? p.resolve(data.result) : p.reject(new Error(data.error))
  }
  worker.onerror = (event) => {
    const err = new Error(event.message || 'COLMAP database worker failed')
    for (const [id, p] of pending) { pending.delete(id); p.reject(err) }
  }
  return worker
}

function call(op, args, transfer = []) {
  const id = nextId++
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    try { getWorker().postMessage({ id, op, args }, transfer) }
    catch (err) { pending.delete(id); reject(err) }
  })
}

export async function inspectColmapDatabase(file) {
  const buffer = await file.arrayBuffer()
  return call('inspect', [buffer, file.name], [buffer])
}
export const readColmapDatabase = (options) => call('read', [options])
export const exportColmapDatabase = (bundle) => call('export', [bundle])
export function disposeColmapDatabase() {
  if (worker) worker.terminate()
  worker = null
  for (const [id, p] of pending) { pending.delete(id); p.reject(new Error('COLMAP database session closed')) }
}

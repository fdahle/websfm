import { trackPersistence } from './persistence.js'

// Captures project identity and payload at the call site. Every caller receives
// the promise for the whole drain, including edits arriving during a write.
export function coalescedSave(label, write) {
  const queues = new Map()
  return (projectId, value) => {
    const existing = queues.get(projectId)
    const data = JSON.parse(JSON.stringify(value))
    if (existing) { existing.latest = data; return existing.promise }
    const state = { latest: data, promise: null }
    state.promise = trackPersistence(`${label}:${projectId}`, async () => {
      while (state.latest) {
        const snapshot = state.latest
        await write(projectId, snapshot)
        if (state.latest === snapshot) state.latest = null
      }
    })
    queues.set(projectId, state)
    state.promise.then(() => queues.delete(projectId), () => queues.delete(projectId))
    return state.promise
  }
}

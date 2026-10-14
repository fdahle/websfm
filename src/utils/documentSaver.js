import { trackPersistence } from './persistence.js'

// One project document (sensors.json, gcps.json, project.json, …) written from the
// store's current state. Every project-scoped store saves through one of these, so
// the rules live here rather than in each store:
//
//   • Coalesced. At most one write is in flight; a save() arriving during it queues
//     exactly one more, and that re-run builds from the state as it is THEN — N
//     edits collapse to ≤ 2 ordered writes. Callers get the promise for the whole
//     drain, so `await save()` means "my edit is on disk".
//   • Pinned to its project. A save belongs to the project open when it was asked
//     for; if that project is no longer open when the (re-)write would start, it
//     is dropped — `build()` would read the next project's state. A save asked for
//     by the next project while the old one drains runs after it.
//   • Tracked as one operation, so flushPersistence() waits for the re-runs too,
//     not just the write that happened to be pending when it looked.
//
// `build()` returns the document; `write(projectId, doc)` stores it. `onError(err)`
// (optional) receives a failed write; without it, save() rejects.
export function createDocumentSaver({ label, currentProjectId, isPersisting = () => true, build, write, onError }) {
  let inFlight = null, inFlightProject = null, again = false

  function save() {
    const projectId = currentProjectId()
    if (!projectId || !isPersisting()) return Promise.resolve()
    if (inFlight) {
      if (inFlightProject === projectId) { again = true; return inFlight }
      return inFlight.then(save, save)
    }
    inFlightProject = projectId
    const run = trackPersistence(`${label}:${projectId}`, async () => {
      do {
        again = false
        if (currentProjectId() !== projectId) return
        await write(projectId, build())
      } while (again)
    })
    inFlight = run.finally(() => { inFlight = null; inFlightProject = null })
    return onError ? inFlight.catch(onError) : inFlight
  }

  return save
}

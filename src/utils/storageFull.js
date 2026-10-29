import { isStorageFull } from './opfs/base.js'

// A browser-stored project that runs out of space can move to a folder on disk and
// carry on there, instead of its writes failing. The app registers the handler
// (useProjectLifecycle: it asks, picks the folder and moves the project). Every
// tracked write asks through askToMove when it finds storage full (utils/persistence.js
// trackPersistence), and so does a run that retries its own writes (storageFullRetry,
// the depth-map run).

let handler = null
// The question being asked: every write that finds storage full meanwhile waits for it.
let answer = null
// A "no": later writes that find storage full fail at once, without asking again,
// until the failed saves are cleared (saved after all, or dismissed).
let declined = false

// `fn({ projectId })` → true once the project has moved (its writes now land in the
// folder), false when it did not (the user said no, or it cannot move). `projectId`
// is the run's project, or undefined for the open one.
export function setStorageFullHandler(fn) {
  handler = fn
  declined = false
}

// True while the question (and the move it may start) is under way.
export const isAsking = () => !!answer

export function clearStorageFullDecline() {
  declined = false
}

// One question at a time. `settleFirst()` → the writes in flight; they finish (or
// fail) before the project is copied, so the copy holds everything that landed.
// → true once the project has moved.
export function askToMove({ projectId, settleFirst = () => [] } = {}) {
  if (!handler || declined) return Promise.resolve(false)
  answer ??= Promise.allSettled(settleFirst())
    .then(() => handler({ projectId }))
    .then((moved) => {
      if (!moved) declined = true
      return !!moved
    })
    .finally(() => {
      answer = null
    })
  return answer
}

// For a run that retries its own writes: → (err, write) => the retried write's
// promise; rethrows `err` when it cannot help.
export function storageFullRetry({ projectId, settleFirst = () => [] }) {
  return async (err, write) => {
    if (!isStorageFull(err) || !handler) throw err
    if (!(await askToMove({ projectId, settleFirst }))) throw err
    return write()
  }
}

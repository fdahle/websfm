import { isStorageFull } from './opfs/base.js'

// A browser-stored project that runs out of space during a run can move to a folder
// on disk and carry on there, instead of the run failing. The app registers the
// handler (useProjectLifecycle: it asks, picks the folder and moves the project) and
// a writer that can retry, the depth-map run, wraps its writes with storageFullRetry.

let handler = null

// `fn({ projectId })` → true once the project has moved (its writes now land in the
// folder), false when it did not (the user stopped, or it cannot move).
export function setStorageFullHandler(fn) {
  handler = fn
}

// One question per run: the first write that finds storage full asks, every other
// one waits for that answer, and after a "stop" they fail at once.
// `settleFirst()` → the run's writes in flight; they finish (or fail) before the
// project is copied, so the copy holds everything that landed.
// → (err, write) => the retried write's promise; rethrows `err` when it cannot help.
export function storageFullRetry({ projectId, settleFirst = () => [] }) {
  let answer = null
  return async (err, write) => {
    if (!isStorageFull(err) || !handler) throw err
    answer ??= Promise.allSettled(settleFirst()).then(() => handler({ projectId }))
    if (!(await answer)) throw err
    return write()
  }
}

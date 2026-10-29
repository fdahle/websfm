import { shallowRef } from 'vue'
import { isStorageFull } from './opfs/base.js'
import { askToMove, clearStorageFullDecline, isAsking } from './storageFull.js'

export const pendingPersistence = shallowRef(0)
export const persistenceFailures = shallowRef([])
const pending = new Set()
const failures = new Map()
const queues = new Map()

// Writes waiting for the storage-full question (askToMove): the move waits for the
// other writes in flight, never for these, which wait for it.
const parked = new Set()
// The others, settled, or after a while: a write may itself wait on a parked one.
const settleUnparked = () => [
  Promise.race([
    Promise.allSettled([...pending].filter((p) => !parked.has(p))),
    new Promise((resolve) => setTimeout(resolve, 15000)),
  ]),
]

/** Register before the first await, including directory lookups and queued writes. */
export function trackPersistence(key, work) {
  pendingPersistence.value++
  // Browser storage full: ask to move the project to a folder (utils/storageFull.js);
  // once it has moved, the write goes there. A write begun while the question is
  // open (the move's own index write among them) fails as it would without one, so it
  // never waits on the move it is part of; it stays a failed save, retried after the move.
  const duringQuestion = isAsking()
  const promise = Promise.resolve()
    .then(work)
    .catch(async (error) => {
      if (!isStorageFull(error) || duringQuestion) throw error
      parked.add(promise)
      let moved = false
      try {
        moved = await askToMove({ settleFirst: settleUnparked })
      } finally {
        parked.delete(promise)
      }
      if (!moved) throw error
      return work()
    })
  pending.add(promise)
  promise
    .then(
      () => failures.delete(key),
      (error) => {
        failures.set(key, { key, error, retry: work })
      },
    )
    .finally(() => {
      pending.delete(promise)
      pendingPersistence.value--
      persistenceFailures.value = [...failures.values()]
      if (!failures.size) clearStorageFullDecline()
    })
  return promise
}

export async function flushPersistence() {
  while (pending.size) await Promise.allSettled([...pending])
  if (failures.size)
    throw new Error(`Unsaved changes: ${[...failures.values()][0].error?.message ?? 'storage write failed'}`)
}

/** Forget an operation only after its caller explicitly rolled back the edit. */
export function discardPersistenceFailure(key) {
  failures.delete(key)
  persistenceFailures.value = [...failures.values()]
  if (!failures.size) clearStorageFullDecline()
}

/** The "Unsaved changes" card's Dismiss: forget every failed save (what it held stays in this session only). */
export function discardAllPersistenceFailures() {
  failures.clear()
  persistenceFailures.value = []
  clearStorageFullDecline()
}

export async function retryPersistence() {
  for (const { key, retry } of [...failures.values()]) {
    if (failures.has(key)) await trackPersistence(key, retry).catch(() => {})
  }
  await flushPersistence()
}

/** Web Locks coordinate tabs; the fallback also serializes independent store instances. */
export function persistenceLock(key, work) {
  if (globalThis.navigator?.locks?.request) return navigator.locks.request(`websfm:${key}`, work)
  const previous = queues.get(key) ?? Promise.resolve()
  const run = previous.then(work, work)
  const tail = run.then(
    () => {},
    () => {},
  )
  queues.set(key, tail)
  tail.then(() => {
    if (queues.get(key) === tail) queues.delete(key)
  })
  return run
}

export function ignoreMissing(error) {
  if (error?.name !== 'NotFoundError') throw error
}

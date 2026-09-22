import { shallowRef } from 'vue'

export const pendingPersistence = shallowRef(0)
export const persistenceFailures = shallowRef([])
const pending = new Set()
const failures = new Map()
const queues = new Map()

/** Register before the first await, including directory lookups and queued writes. */
export function trackPersistence(key, work) {
  pendingPersistence.value++
  const promise = Promise.resolve().then(work)
  pending.add(promise)
  promise.then(() => failures.delete(key), error => {
    failures.set(key, { key, error, retry: work })
  }).finally(() => {
    pending.delete(promise)
    pendingPersistence.value--
    persistenceFailures.value = [...failures.values()]
  })
  return promise
}

export async function flushPersistence() {
  while (pending.size) await Promise.allSettled([...pending])
  if (failures.size) throw new Error(`Unsaved changes: ${[...failures.values()][0].error?.message ?? 'storage write failed'}`)
}

/** Forget an operation only after its caller explicitly rolled back the edit. */
export function discardPersistenceFailure(key) {
  failures.delete(key)
  persistenceFailures.value = [...failures.values()]
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
  const tail = run.then(() => {}, () => {})
  queues.set(key, tail)
  tail.then(() => { if (queues.get(key) === tail) queues.delete(key) })
  return run
}

export function ignoreMissing(error) {
  if (error?.name !== 'NotFoundError') throw error
}

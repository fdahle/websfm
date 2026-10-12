// A small keyed task queue with bounded concurrency, used for background work that
// many callers may ask for at once (one thumbnail per image, requested by every row
// that scrolls into view). Requests for a key that is already queued or running
// share one promise; an `urgent` request jumps ahead of the backlog (newest urgent
// first — the row the user is looking at now beats the one they scrolled past).
// `cancelPending()` drops everything not yet started (a project switch); running
// tasks finish, and their callers decide whether the result is still wanted.

export class QueueCancelled extends Error {
  constructor(reason = 'cancelled') { super(reason); this.name = 'QueueCancelled' }
}

export function createKeyedQueue({ concurrency = 2 } = {}) {
  const waiting = []                // [{ key, run, resolve, reject }]
  const byKey = new Map()           // key → { promise, job | null (running) }
  let active = 0

  function pump() {
    while (active < concurrency && waiting.length) {
      const job = waiting.shift()
      const rec = byKey.get(job.key)
      if (rec) rec.job = null
      active++
      // Free the key BEFORE settling, so a caller that awaits the result and asks
      // again gets a fresh run rather than the settled promise.
      const settle = (fn, value) => {
        active--
        if (byKey.get(job.key)?.promise === job.promise) byKey.delete(job.key)
        fn(value)
        pump()
      }
      Promise.resolve()
        .then(job.run)
        .then((v) => settle(job.resolve, v), (e) => settle(job.reject, e))
    }
  }

  function request(key, run, { urgent = false } = {}) {
    const existing = byKey.get(key)
    if (existing) {
      if (urgent && existing.job) {
        const i = waiting.indexOf(existing.job)
        if (i > 0) { waiting.splice(i, 1); waiting.unshift(existing.job) }
      }
      return existing.promise
    }
    let resolve, reject
    const promise = new Promise((res, rej) => { resolve = res; reject = rej })
    const job = { key, run, resolve, reject, promise }
    byKey.set(key, { promise, job })
    if (urgent) waiting.unshift(job)
    else waiting.push(job)
    pump()
    return promise
  }

  function cancelPending(reason) {
    const dropped = waiting.splice(0)
    for (const job of dropped) {
      if (byKey.get(job.key)?.promise === job.promise) byKey.delete(job.key)
      job.reject(new QueueCancelled(reason))
    }
    return dropped.length
  }

  return {
    request,
    cancelPending,
    has: (key) => byKey.has(key),
    get pending() { return waiting.length },
    get active() { return active },
  }
}

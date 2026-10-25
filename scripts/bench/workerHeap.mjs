// Worker heap sampler for the bench (Chrome DevTools Protocol).
//
// The renderer's `performance.memory` says nothing about the SfM worker, which is a
// separate V8 isolate with its own ~4 GB ceiling — the one the Monster run died at.
// This attaches to every dedicated worker of the page and polls
// `Runtime.getHeapUsage`, keeping the peak per *segment*. Two numbers: the V8 heap
// (`usedSize` — JS objects, the ~4 GB per-isolate ceiling) and that plus the
// ArrayBuffer backing stores (`backingStorageSize` — typed arrays live outside the
// heap, so they do not count against the ceiling but do count as memory). The caller closes a segment
// by name (`mark`), typically when a stage-boundary log line arrives, so the result
// reads "peak while registering", "peak during the post-filter passes", and so on.
//
// Sampling is periodic, so a peak shorter than the interval can be missed; the
// overall peak is also kept per worker. Inspector messages interrupt running JS, so a
// worker busy in one long synchronous call still answers.

export async function startWorkerHeapSampler(page, { intervalMs = 250 } = {}) {
  const cdp = await page.context().newCDPSession(page)
  const workers = new Map() // sessionId → { url, peak }
  const pending = new Map()
  let nextId = 1
  // `timeoutMs`: give up (null) on a worker that does not answer in time, so one stuck
  // worker cannot hold up the samples or a profile of the others.
  const send = (sessionId, method, params = {}, timeoutMs = 0) =>
    new Promise((resolve) => {
      const id = nextId++
      pending.set(id, resolve)
      if (timeoutMs > 0)
        setTimeout(() => {
          if (pending.delete(id)) resolve(null)
        }, timeoutMs).unref?.()
      cdp
        .send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
        .catch(() => {
          pending.delete(id)
          resolve(null)
        })
    })
  cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const m = JSON.parse(message)
    const done = pending.get(m.id)
    if (done) {
      pending.delete(m.id)
      done(m.result ?? null)
    }
  })
  let onAttach = null // set while a CPU profile runs (profile below)
  cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo, waitingForDebugger }) => {
    if (targetInfo.type !== 'worker') return
    workers.set(sessionId, { url: targetInfo.url, peak: 0, peakWithBuffers: 0 })
    if (waitingForDebugger) send(sessionId, 'Runtime.runIfWaitingForDebugger')
    onAttach?.(sessionId)
  })
  cdp.on('Target.detachedFromTarget', ({ sessionId }) => workers.delete(sessionId))
  // Non-flat sessions: commands travel through sendMessageToTarget, so this works over
  // Playwright's page session without touching its own (flat) attachment.
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false })

  let segPeak = 0,
    segWorker = null,
    segPeakBuf = 0
  const segments = [] // { label, peakBytes, peakWithBuffersBytes, worker }
  let busy = false
  const timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      await Promise.all(
        [...workers].map(async ([sessionId, w]) => {
          const r = await send(sessionId, 'Runtime.getHeapUsage', {}, 4 * intervalMs)
          if (!r) return
          const withBuf = r.usedSize + (r.backingStorageSize ?? 0)
          w.last = { heap: r.usedSize, buffers: r.backingStorageSize ?? 0 }
          if (r.usedSize > w.peak) w.peak = r.usedSize
          if (withBuf > w.peakWithBuffers) w.peakWithBuffers = withBuf
          if (r.usedSize > segPeak) {
            segPeak = r.usedSize
            segWorker = sessionId
          }
          if (withBuf > segPeakBuf) segPeakBuf = withBuf
        }),
      )
    } finally {
      busy = false
    }
  }, intervalMs)
  timer.unref?.()

  return {
    // Close the current segment under `label` and start the next one.
    mark(label) {
      segments.push({ label, peakBytes: segPeak, peakWithBuffersBytes: segPeakBuf, worker: segWorker })
      segPeak = 0
      segWorker = null
      segPeakBuf = 0
    },
    // Each live worker's latest sample: { url, heap, buffers } (bytes).
    current() {
      return [...workers.values()].filter((w) => w.last).map((w) => ({ url: w.url, ...w.last }))
    },
    // Segments since the last take(), plus each live worker's overall peak.
    take() {
      const out = { segments: segments.splice(0), workers: [...workers.values()].map((w) => ({ ...w })) }
      return out
    },
    // CPU profiles of every worker for `seconds` (Profiler over the same sessions): each
    // worker's top functions by self time, and the raw profiles for DevTools.
    // A worker that does not answer within a few seconds is left out. `until`: a promise that ends the profile early (the stage finished first).
    async profile(seconds, { interval = 1000, until = null } = {}) {
      // A worker that starts during the profile is profiled from then on: after a page
      // reload (the bench's `reopen`) the pool is created only when the stage's work
      // reaches it, and a profile that took only the workers alive at its start was empty.
      const T = 5000
      const ids = []
      const start = async (sid) => {
        if (!(await send(sid, 'Profiler.enable', {}, T))) return
        await send(sid, 'Profiler.setSamplingInterval', { interval }, T)
        if (await send(sid, 'Profiler.start', {}, T)) ids.push(sid)
      }
      onAttach = (sid) => void start(sid)
      await Promise.all([...workers.keys()].map(start))
      await Promise.race([new Promise((r) => setTimeout(r, seconds * 1000)), until].filter(Boolean))
      onAttach = null
      return Promise.all(
        ids.map(async (sid) => {
          const r = await send(sid, 'Profiler.stop', {}, 30_000)
          const profile = r?.profile
          const self = new Map()
          if (profile) {
            const dt = new Map()
            for (let i = 1; i < (profile.samples ?? []).length; i++) {
              dt.set(profile.samples[i], (dt.get(profile.samples[i]) ?? 0) + (profile.timeDeltas[i] ?? 0))
            }
            for (const n of profile.nodes) {
              const us = dt.get(n.id) ?? 0
              if (!us) continue
              const { functionName, url, lineNumber } = n.callFrame
              const key = `${functionName || '(anonymous)'} ${url.split('/').pop()}:${lineNumber + 1}`
              self.set(key, (self.get(key) ?? 0) + us)
            }
          }
          const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 25)
          return {
            worker: workers.get(sid)?.url ?? sid,
            totalMs: [...self.values()].reduce((a, b) => a + b, 0) / 1000,
            top,
            profile,
          }
        }),
      )
    },
    async stop() {
      clearInterval(timer)
      await cdp.detach().catch(() => {})
    },
  }
}

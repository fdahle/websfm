// Worker heap sampler for the bench (Chrome DevTools Protocol).
//
// The renderer's `performance.memory` says nothing about the SfM worker, which is a
// separate V8 isolate with its own ~4 GB ceiling — the one the Monster run died at.
// This attaches to every dedicated worker of the page and polls
// `Runtime.getHeapUsage`, keeping the peak per *segment*. The caller closes a segment
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
  const send = (sessionId, method, params = {}) => new Promise((resolve) => {
    const id = nextId++
    pending.set(id, resolve)
    cdp.send('Target.sendMessageToTarget', { sessionId, message: JSON.stringify({ id, method, params }) })
      .catch(() => { pending.delete(id); resolve(null) })
  })
  cdp.on('Target.receivedMessageFromTarget', ({ message }) => {
    const m = JSON.parse(message)
    const done = pending.get(m.id)
    if (done) { pending.delete(m.id); done(m.result ?? null) }
  })
  cdp.on('Target.attachedToTarget', ({ sessionId, targetInfo, waitingForDebugger }) => {
    if (targetInfo.type !== 'worker') return
    workers.set(sessionId, { url: targetInfo.url, peak: 0 })
    if (waitingForDebugger) send(sessionId, 'Runtime.runIfWaitingForDebugger')
  })
  cdp.on('Target.detachedFromTarget', ({ sessionId }) => workers.delete(sessionId))
  // Non-flat sessions: commands travel through sendMessageToTarget, so this works over
  // Playwright's page session without touching its own (flat) attachment.
  await cdp.send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: false, flatten: false })

  let segPeak = 0, segWorker = null
  const segments = [] // { label, peakBytes, worker }
  let busy = false
  const timer = setInterval(async () => {
    if (busy) return
    busy = true
    try {
      await Promise.all([...workers].map(async ([sessionId, w]) => {
        const r = await send(sessionId, 'Runtime.getHeapUsage')
        if (!r) return
        if (r.usedSize > w.peak) w.peak = r.usedSize
        if (r.usedSize > segPeak) { segPeak = r.usedSize; segWorker = sessionId }
      }))
    } finally { busy = false }
  }, intervalMs)

  return {
    // Close the current segment under `label` and start the next one.
    mark(label) {
      segments.push({ label, peakBytes: segPeak, worker: segWorker })
      segPeak = 0; segWorker = null
    },
    // Segments since the last take(), plus each live worker's overall peak.
    take() {
      const out = { segments: segments.splice(0), workers: [...workers.values()].map((w) => ({ ...w })) }
      return out
    },
    async stop() { clearInterval(timer); await cdp.detach().catch(() => {}) },
  }
}

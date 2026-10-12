// Run async work with a bounded number of operations in flight. File System
// Access calls are especially sensitive to an unbounded Promise.all: OPFS can
// tolerate it, while real folder-backed projects often serialize internally and
// pay extra contention/context-switch overhead.
export async function mapConcurrent(items, limit, mapper) {
  const list = Array.from(items || [])
  if (list.length === 0) return []
  const width = Math.max(1, Math.min(list.length, Math.floor(limit) || 1))
  const results = new Array(list.length)
  let next = 0

  async function worker() {
    while (true) {
      const index = next++
      if (index >= list.length) return
      results[index] = await mapper(list[index], index)
    }
  }

  await Promise.all(Array.from({ length: width }, () => worker()))
  return results
}

// Give the browser one chance to paint before more synchronous work. A progress
// label set inside a long main-thread task is never drawn: the frame only renders
// once the task yields. rAF waits for the next frame, the timeout lets it present.
// A background tab never fires rAF, so a 100 ms cap keeps the load moving there;
// outside a browser (tests, workers without rAF) it is a plain macrotask.
export function yieldToPaint() {
  return new Promise((resolve) => {
    if (typeof requestAnimationFrame !== 'function') { setTimeout(resolve, 0); return }
    const cap = setTimeout(resolve, 100)
    requestAnimationFrame(() => setTimeout(() => { clearTimeout(cap); resolve() }, 0))
  })
}

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

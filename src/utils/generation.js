// A "latest call wins" token for async rebuilds. `next()` starts a new generation
// and returns its token; `isCurrent(token)` tells a call resuming after an await
// whether it is still the newest one (no later `next()`, no `invalidate()` — e.g.
// on unmount). The caller checks after every await and abandons a stale run before
// it touches shared state, so overlapping rebuilds never both commit.
export function createGeneration() {
  let current = 0
  return {
    next: () => ++current,
    isCurrent: (token) => token === current,
    invalidate: () => {
      current++
    },
  }
}

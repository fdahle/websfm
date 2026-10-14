import { it, expect } from 'vitest'
import { registerProjectStore, restoreProjectStores } from './projectStores.js'

// A store whose restore resolves when the test says so, and records what it holds.
function fakeStore(id) {
  const pending = []
  const store = {
    $id: id, data: null,
    restore: ({ projectId }) => new Promise((resolve) => pending.push(() => { store.data = projectId; resolve() })),
    clear: () => { store.data = null },
  }
  registerProjectStore(() => store)
  return { store, finishNext: () => pending.shift()() }
}
const tick = () => new Promise((r) => setTimeout(r, 0))

it('clears a restore that finished after its project closed, and runs the next project after it', async () => {
  const { store, finishNext } = fakeStore('fake')
  let open = 'a'
  const runA = restoreProjectStores({ projectId: 'a', projectData: {}, isCurrent: () => open === 'a' })
  await tick()
  open = 'b'                                    // switched while a's read is still pending
  const runB = restoreProjectStores({ projectId: 'b', projectData: {}, isCurrent: () => open === 'b' })
  await tick()
  finishNext()                                  // a's read lands late …
  await runA
  expect(store.data).toBeNull()                 // … and is cleared, not kept for b
  await tick()
  finishNext()                                  // b's run started only after a's settled
  await runB
  expect(store.data).toBe('b')
})

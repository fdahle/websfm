// ── Project-scoped store registry ─────────────────────────────────────────────
//
// Every store whose state belongs to a *project* (and is persisted per-project)
// implements a small uniform contract so opening/closing a project doesn't have
// to know about each store individually:
//
//   async restore(ctx)  — load this store's slice for the given project
//   clear()             — reset this store (optionally purging persisted data)
//
//   ctx = { projectId: string, projectData: object, report(label, done?, total?) }
//     projectData carries the project record, including `images` and `crs`;
//     report (always present) feeds the load overlay — see restoreProjectStores.
//
// Registration happens on module import, via the registerProjectStore() wrapper
// around each store's defineStore(). App.vue imports every store (for their direct
// APIs), so all of them register.
//
// Ordering: App.vue restores the two stores with bespoke ordering needs — sensors
// then images — manually, *before* calling restoreProjectStores(). Every store in
// this registry restores after that, and they are mutually independent at restore
// time (each loads its own slice from OPFS; image-linked stores re-resolve against
// the already-loaded image list), so registration order among them does not matter.
//
// To onboard a new project-scoped store: implement the contract, wrap its
// defineStore() in registerProjectStore(), and delete any manual restore/clear
// lines from App.vue — the fan-out below picks it up automatically.

const registry = []

// Register a store factory (the `useXStore` function). Returns it for chaining,
// so a store module can `export const useXStore = registerProjectStore(defineStore(...))`.
export function registerProjectStore(useStore) {
  if (!registry.includes(useStore)) registry.push(useStore)
  return useStore
}

const now = () => globalThis.performance?.now?.() ?? Date.now()

// Restore every registered store concurrently. Sensors and images are handled
// before this registry; the registered stores are independent once those exist.
//
// `onProgress(storeId, state)` (optional) is the load overlay's sink: `state` is
// `{ label, done?, total? }` while a store is restoring and `null` once it is done.
// Each store receives `ctx.report(label, done?, total?)` bound to its own id, so a
// slow restore can say what it is doing; a store that never reports still shows
// as pending under its id.
export async function restoreProjectStores(ctx) {
  const { onProgress, ...base } = ctx
  return Promise.all(registry.map(async (useStore) => {
    const store = useStore()
    if (typeof store.restore !== 'function') return null
    const id = store.$id || 'unknown'
    const report = (label, done = null, total = null) => onProgress?.(id, { label, done, total })
    report(null)
    const started = now()
    try {
      await store.restore({ ...base, report })
    } finally {
      onProgress?.(id, null)
    }
    return { store: id, ms: now() - started }
  })).then((items) => items.filter(Boolean))
}

// Clear every registered store. `opts` is forwarded to each store's clear()
// (e.g. { purge: true } to also delete persisted data).
export function clearProjectStores(opts) {
  for (const useStore of registry) {
    const store = useStore()
    if (typeof store.clear === 'function') store.clear(opts)
  }
}

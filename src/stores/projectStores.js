// ── Project-scoped store registry ─────────────────────────────────────────────
//
// Every store whose state belongs to a *project* (and is persisted per-project)
// implements a small uniform contract so opening/closing a project doesn't have
// to know about each store individually:
//
//   async restore(ctx)  — load this store's slice for the given project
//   clear()             — reset this store (optionally purging persisted data)
//
//   ctx = { projectId: string, projectData: object }
//     projectData carries the project record, including `images` and `crs`.
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

// Restore every registered store for a project, in registration order.
export async function restoreProjectStores(ctx) {
  for (const useStore of registry) {
    const store = useStore()
    if (typeof store.restore === 'function') await store.restore(ctx)
  }
}

// Clear every registered store. `opts` is forwarded to each store's clear()
// (e.g. { purge: true } to also delete persisted data).
export function clearProjectStores(opts) {
  for (const useStore of registry) {
    const store = useStore()
    if (typeof store.clear === 'function') store.clear(opts)
  }
}

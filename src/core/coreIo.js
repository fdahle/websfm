// The I/O that a few core modules need, handed in by the app instead of reached for:
// the network (a CRS definition from epsg.io, the CRS catalog, a geoid grid, terrain
// tiles), the app's small JSON files in OPFS (the CRS definition cache) and the model
// weight cache. src/utils/installCoreIo.js installs the browser's versions on the main
// thread and in every worker at start; a Node test installs fakes, or nothing.
//
// Core itself stays pure (ESLint keeps fetch, OPFS, canvases and the DOM out of
// src/core): it calls `coreIo().fetch(...)` and the like, and a part nobody installed
// fails with a message that says so.
//
// Pure module: no Vue/Pinia/OPFS, so it bundles into the worker unchanged.

const PARTS = {
  // fetch(url, init) → Response
  fetch: 'the network',
  // readAppJson(name) → parsed JSON or null; writeAppJson(name, data)
  readAppJson: 'app storage',
  writeAppJson: 'app storage',
  // loadModelBytes(model, onLog, label) → Uint8Array (cache first, then the network)
  loadModelBytes: 'the model cache',
}

const installed = {}

/** Install some or all of the I/O parts (later calls replace what they name). */
export function installCoreIo(parts) {
  for (const [name, fn] of Object.entries(parts)) {
    if (!(name in PARTS)) throw new Error(`Unknown core I/O part "${name}"`)
    installed[name] = fn
  }
}

/** Remove every installed part (for tests). */
export function resetCoreIo() {
  for (const name of Object.keys(installed)) delete installed[name]
}

// Every part is asynchronous, so a missing one rejects like a failed read would.
const missing = (name) => () =>
  Promise.reject(new Error(`No access to ${PARTS[name]} here (core I/O "${name}" is not installed)`))

/** The installed I/O; a part that is not installed rejects when called. */
export function coreIo() {
  return Object.fromEntries(Object.keys(PARTS).map((name) => [name, installed[name] ?? missing(name)]))
}

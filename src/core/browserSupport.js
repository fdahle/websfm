// What WebSfM needs from the browser, and what each missing piece costs the user. One
// table for the warning at start (components/layout/BrowserWarning.vue), System info and
// the guide's Supported browsers section, so the three say the same thing. Pure: the
// probe that fills `caps` is utils/browserCaps.js.
//
// caps = { storage, webgl2, webgpu, isolated, sharedMemory, simd, memory64,
//          folderAccess, savePicker, deviceMemoryGB }

/**
 * @typedef {object} BrowserFeature
 * @property {string} id
 * @property {string} label       the name System info shows
 * @property {(caps: object) => boolean} ok
 * @property {string} without     what the user loses without it, in the app's terms
 * @property {boolean} warn       whether the start warning names it
 */

/** @type {BrowserFeature[]} */
export const BROWSER_FEATURES = [
  {
    id: 'storage',
    label: 'Project storage (OPFS)',
    ok: (c) => !!c.storage,
    without: 'Projects cannot be saved, so closing the tab loses the work. A private window often blocks storage.',
    warn: true,
  },
  {
    id: 'webgl2',
    label: 'WebGL 2',
    ok: (c) => !!c.webgl2,
    without: 'The 3D view and the map cannot draw.',
    warn: true,
  },
  {
    id: 'webgpu',
    label: 'WebGPU',
    ok: (c) => !!c.webgpu,
    without: 'Depth maps, matching and the learned matchers run on the CPU, which is slower.',
    warn: true,
  },
  {
    id: 'threads',
    label: 'Threads (cross-origin isolation, shared memory, WASM SIMD)',
    ok: (c) => !!(c.isolated && c.sharedMemory && c.simd),
    without:
      'Bundle adjustment and the learned detectors run on one thread, and a point cloud stops at about 89 million points.',
    warn: true,
  },
  {
    id: 'deviceMemory',
    label: 'Device memory reading',
    ok: (c) => Number.isFinite(c.deviceMemoryGB) && c.deviceMemoryGB > 0,
    without:
      'The memory safety limit starts at 2 GB, because the browser does not say how much memory the device has. ' +
      'Raise it in Other ▸ Settings ▸ Compute if the device has more.',
    warn: true,
  },
  {
    id: 'folderAccess',
    label: 'Folders on disk',
    ok: (c) => !!c.folderAccess,
    without:
      'Projects are kept in browser storage only, not in a folder on your disk; Export project file… keeps a copy.',
    warn: true,
  },
  {
    id: 'memory64',
    label: 'WASM Memory64',
    ok: (c) => !!c.memory64,
    without: 'A very large dense cloud or mesh stops at 4 GB of working memory.',
    warn: false,
  },
  {
    id: 'savePicker',
    label: 'Save to a chosen file',
    ok: (c) => !!c.savePicker,
    without: 'Exports larger than about 256 MB are downloaded instead of written where you choose.',
    warn: false,
  },
]

/**
 * The features this browser lacks, in table order.
 * @param {object} caps
 * @returns {BrowserFeature[]}
 */
export function missingFeatures(caps) {
  return BROWSER_FEATURES.filter((f) => !f.ok(caps || {}))
}

/**
 * What the start warning lists: the missing features it names, as { id, label, without }.
 * @param {object} caps
 */
export function browserWarnings(caps) {
  return missingFeatures(caps)
    .filter((f) => f.warn)
    .map(({ id, label, without }) => ({ id, label, without }))
}

/**
 * Every feature with whether this browser has it, for System info.
 * @param {object} caps
 */
export function featureReport(caps) {
  return BROWSER_FEATURES.map(({ id, label, without, ok }) => ({ id, label, without, ok: ok(caps || {}) }))
}

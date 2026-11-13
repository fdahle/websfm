// The browser's I/O for the core modules that need some (core/coreIo.js): installed
// once on the main thread (main.js) and at the start of every worker.
import { installCoreIo } from '../core/coreIo.js'
import { readAppJson, writeAppJson } from './opfs.js'
import { loadModelBytes } from './modelCache.js'

export function installBrowserCoreIo() {
  installCoreIo({
    fetch: (...args) => fetch(...args),
    readAppJson,
    writeAppJson,
    loadModelBytes,
  })
}

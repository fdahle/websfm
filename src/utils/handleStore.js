// Persistent storage for `FileSystemDirectoryHandle`s — one tiny IndexedDB
// database, keyed by project id.
//
// Why IndexedDB and not localStorage: a directory handle is not serialisable to
// a string, it is *structured-cloneable*. localStorage only holds strings, so it
// physically cannot keep one. IndexedDB stores the clone, and the browser
// re-hydrates a live handle (still subject to its own permission check) on the
// next visit — which is what makes a folder-backed project survive a reload.
//
// Deliberately dependency-free and tiny: three operations, no schema migration
// story beyond "bump DB_VERSION and recreate the store".

const DB_NAME = 'websfm-handles'
const DB_VERSION = 1
const STORE = 'projectRoots'

let dbPromise = null

function openDb() {
  if (dbPromise) return dbPromise
  dbPromise = new Promise((resolve, reject) => {
    if (typeof indexedDB === 'undefined') { reject(new Error('IndexedDB unavailable')); return }
    const req = indexedDB.open(DB_NAME, DB_VERSION)
    req.onupgradeneeded = () => {
      const db = req.result
      if (!db.objectStoreNames.contains(STORE)) db.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }).catch((err) => { dbPromise = null; throw err })
  return dbPromise
}

function tx(mode, fn) {
  return openDb().then((db) => new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode)
    const req = fn(t.objectStore(STORE))
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  }))
}

// All three swallow failures into a benign result: a missing/blocked IndexedDB
// must degrade a folder project to "needs re-picking", never break project open.

export async function saveProjectHandle(projectId, dirHandle) {
  try {
    await tx('readwrite', (s) => s.put(dirHandle, projectId))
    return true
  } catch {
    return false
  }
}

export async function loadProjectHandle(projectId) {
  try {
    return (await tx('readonly', (s) => s.get(projectId))) || null
  } catch {
    return null
  }
}

export async function deleteProjectHandle(projectId) {
  try {
    await tx('readwrite', (s) => s.delete(projectId))
  } catch { /* nothing to forget */ }
}

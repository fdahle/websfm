// Folder-backed projects — the pure rules. The handle plumbing is in
// utils/handleStore.js, the wiring in useProjectsStore.
//
// A "folder project" keeps its files in a directory the user picked on disk
// instead of in OPFS. The layout is byte-identical either way (see
// projectArchive.js), so this module owns only two things: which storage a
// project claims, and what to DO when opening one — a small state machine that
// is worth isolating because permissions are where this feature actually bites.

export const STORAGE_OPFS = 'opfs'
export const STORAGE_FOLDER = 'folder'

// Index entries written before folder support have no `storage` field; absent
// means the original backend.
export function projectStorage(entry) {
  return entry?.storage === STORAGE_FOLDER ? STORAGE_FOLDER : STORAGE_OPFS
}

export function isFolderProject(entry) {
  return projectStorage(entry) === STORAGE_FOLDER
}

// `showDirectoryPicker` is Chromium-only (Chrome/Edge/Opera — not Firefox, not
// Safari). Everything else keeps OPFS, which is why OPFS stays the default and
// the option is hidden rather than shown-and-broken elsewhere.
export function folderStorageSupported(win = typeof window !== 'undefined' ? window : null) {
  return !!win && typeof win.showDirectoryPicker === 'function'
}

/**
 * What should opening this project do?
 *
 * `permission` is the result of `queryPermission({ mode: 'readwrite' })` on the
 * stored handle, or null when there is no handle at all.
 *
 *   'open'      — go straight to the normal restore path
 *   'reconnect' — the handle is alive but not yet permitted. `requestPermission`
 *                 REQUIRES a user gesture, so this must surface as a button; a
 *                 silent retry here would simply be rejected.
 *   'repick'    — no usable handle (folder moved, deleted, or IndexedDB lost it).
 *                 Offer a fresh directory pick, or forgetting the project.
 */
export function folderOpenPlan({ entry, handle = null, permission = null } = {}) {
  if (!isFolderProject(entry)) return { action: 'open', reason: 'opfs' }
  if (!handle) return { action: 'repick', reason: 'no-handle' }
  if (permission === 'granted') return { action: 'open', reason: 'granted' }
  if (permission === 'prompt') return { action: 'reconnect', reason: 'prompt' }
  // 'denied' still offers reconnect: the user can grant it from the prompt, and
  // presenting "repick" would wrongly imply the folder is gone.
  if (permission === 'denied') return { action: 'reconnect', reason: 'denied' }
  return { action: 'repick', reason: 'unreadable' }
}

// A picked folder is only adoptable as an existing project if it has a
// project.json. Anything else is either empty (fine — a new project can be
// created there) or someone else's directory (refuse; we would scatter files
// into it). → { ok, error }
export function adoptFolderVerdict({ hasProjectJson, isEmpty }) {
  if (hasProjectJson) return { ok: true }
  if (isEmpty) return { ok: false, error: 'that folder is empty — create a new project in it instead' }
  return { ok: false, error: 'that folder does not contain a websfm project (no project.json)' }
}

// A folder chosen for a NEW project must be empty, or the user must have
// confirmed. websfm writes a whole tree into it and later prunes stale sidecars,
// so sharing it with unrelated files is not safe. → { ok, needsConfirm, error }
export function newFolderVerdict({ isEmpty, hasProjectJson, confirmed = false }) {
  if (hasProjectJson) {
    return { ok: false, error: 'that folder already holds a websfm project — open it instead of creating a new one' }
  }
  if (isEmpty) return { ok: true, needsConfirm: false }
  if (confirmed) return { ok: true, needsConfirm: false }
  return { ok: false, needsConfirm: true, error: 'that folder is not empty' }
}

// A copy is only trusted when both totals match. Used before the OPFS source
// tree is deleted — the one moment where getting this wrong loses data.
export function copyVerified(source, copied) {
  return !!source && !!copied
    && source.files === copied.files
    && source.bytes === copied.bytes
}

// The picker shows this next to a folder project. The full path is deliberately
// not available to web content — `handle.name` (the leaf directory) is all the
// platform exposes, so the label says "folder" to set expectations.
export function folderLabel(entry) {
  const name = entry?.folderName
  return name ? `folder: ${name}` : 'folder'
}

// The `.websfm` project file — pure rules only (no OPFS, no zip library, no DOM).
// The I/O half lives in `utils/projectFile.js`.
//
// Format: a plain ZIP whose entries are the project directory VERBATIM
// (`project.json`, `images/…`, `matches/…`, `recon.*.bin`, …) plus one extra
// root `manifest.json`. Being "just a zip of the project dir" is the whole
// design: there is no second format to keep in sync, an archive is inspectable
// with any unzip tool, and a folder-backed project on disk is byte-identical to
// what an archive contains.
//
// The manifest is the only thing the archive adds. It exists so an import can
// (a) recognise the file before writing anything, (b) refuse an archive from a
// newer app, and (c) name the project without first parsing `project.json`.

import { formatBytes } from '../formatBytes.js'

export const PROJECT_ARCHIVE_FORMAT = 'websfm-project'
export const PROJECT_ARCHIVE_VERSION = 1
export const PROJECT_ARCHIVE_EXT = '.websfm'
export const MANIFEST_NAME = 'manifest.json'

// Never archived. The dev-console stream is a record of a *session*, not project
// data — it is often the largest text file in the tree and means nothing in
// another browser.
export const ARCHIVE_EXCLUDE = ['log.ndjson', 'log.json']
// The copies a format migration keeps (utils/opfs/formatMigration.js) undo it in this
// browser only: the archived documents are already in the new format.
const MIGRATION_LEFTOVER = /(^|\/)format-migration\.json$|\.v\d+\.bak$/

// Recomputable but expensive — the "exclude cached/derived data" option drops
// these three and nothing else. Safe to drop because every one of them heals:
// derived image blobs re-transcode on a cache miss, depth maps are simply absent
// (the store treats absence as "not computed yet"), products regenerate.
export const ARCHIVE_DERIVED_DIRS = ['images-derived', 'depthmaps', 'products']

// Should this project-relative path go into the archive?
export function shouldArchivePath(relPath, { includeDerived = true } = {}) {
  const path = String(relPath || '')
  if (!path) return false
  const top = path.split('/')[0]
  if (ARCHIVE_EXCLUDE.includes(path)) return false
  if (MIGRATION_LEFTOVER.test(path)) return false
  // A run journal (core/runJournal.js) belongs to the tab that ran it.
  if (top === 'runs') return false
  if (!includeDerived && ARCHIVE_DERIVED_DIRS.includes(top)) return false
  return true
}

// Compression method per entry: 8 = deflate, 0 = store.
// JSON is the only thing worth compressing — everything else in a project is
// either already-compressed (JPEG/PNG blobs, the original images) or float
// binary, where deflate costs real CPU for a few percent.
export function archiveCompression(relPath) {
  return /\.json$/i.test(String(relPath || '')) ? 8 : 0
}

export function buildManifest({ project, appVersion = null, includeDerived = true, now = new Date() } = {}) {
  const p = project || {}
  return {
    format: PROJECT_ARCHIVE_FORMAT,
    version: PROJECT_ARCHIVE_VERSION,
    exportedAt: now.toISOString(),
    appVersion,
    includesDerived: !!includeDerived,
    project: {
      name: p.name ?? 'Project',
      sceneType: p.sceneType ?? 'aerial',
      crs: p.crs ?? null,
      createdAt: p.createdAt ?? null,
    },
  }
}

// → { ok, manifest, error }. The error strings are user-facing.
export function validateManifest(raw) {
  if (!raw || typeof raw !== 'object') {
    return { ok: false, error: 'not a WebSfM project file (no manifest)' }
  }
  if (raw.format !== PROJECT_ARCHIVE_FORMAT) {
    return { ok: false, error: `not a WebSfM project file (format "${raw.format ?? '—'}")` }
  }
  const version = Number(raw.version)
  if (!Number.isFinite(version) || version < 1) {
    return { ok: false, error: `project file has an invalid version (${raw.version})` }
  }
  if (version > PROJECT_ARCHIVE_VERSION) {
    return {
      ok: false,
      error:
        `project file was written by a newer version of WebSfM ` +
        `(format v${version}, this app reads up to v${PROJECT_ARCHIVE_VERSION})`,
    }
  }
  return { ok: true, manifest: raw }
}

// A ZIP local-file-header signature. Cheap magic-byte gate before any decode —
// the same discipline as the PLY/LAS sniff (never text-decode a big binary).
export function looksLikeZipHead(head) {
  const u8 = head instanceof Uint8Array ? head : new Uint8Array(head || [])
  return u8.length >= 4 && u8[0] === 0x50 && u8[1] === 0x4b && (u8[2] === 0x03 || u8[2] === 0x05 || u8[2] === 0x07)
}

export function isProjectArchiveName(fileName = '') {
  return new RegExp(`\\${PROJECT_ARCHIVE_EXT}$`, 'i').test(String(fileName))
}

// A safe, readable download name. Keeps the project name recognisable but
// strips anything a filesystem would object to.
export function archiveFileName(projectName) {
  const base = String(projectName || 'project')
    .trim()
    .replace(/[\\/:*?"<>|]+/g, '-')
    .slice(0, 80)
  return `${base || 'project'}${PROJECT_ARCHIVE_EXT}`
}

// Importing never overwrites: a name collision gets a suffix rather than a
// prompt (the project is new and freely renameable afterwards).
export function importedProjectName(name, existingNames = []) {
  const taken = new Set(existingNames)
  const base = String(name || 'Imported project')
  if (!taken.has(base)) return base
  let candidate = `${base} (imported)`
  let n = 2
  while (taken.has(candidate)) candidate = `${base} (imported ${n++})`
  return candidate
}

// Pre-flight for a project file → { ok, error }. The archive is ZIP64 past 4 GiB
// (utils/zip.js), so the only bound is JavaScript's exact integer range for offsets.
export function archiveSizeVerdict(totalBytes) {
  if (!(totalBytes < Number.MAX_SAFE_INTEGER)) {
    return { ok: false, error: `project is ${formatBytes(totalBytes)}, too large for a project file` }
  }
  return { ok: true }
}

// Reject zip entry names that would escape the project directory or collide
// with the manifest. Entry names come from an untrusted file.
export function isSafeArchiveEntry(name) {
  const n = String(name || '')
  if (!n || n.endsWith('/')) return false // directory marker
  if (n.startsWith('/') || /^[a-zA-Z]:/.test(n)) return false
  if (n.includes('\\')) return false
  return !n.split('/').some((p) => p === '' || p === '.' || p === '..')
}

// Per-top-level-section byte counts, for the export log line (heavy-logging
// convention: every derived number the user might question gets printed).
export function summarizeSections(entries) {
  const bySection = new Map()
  for (const { relPath, size } of entries) {
    const parts = String(relPath).split('/')
    const section = parts.length > 1 ? parts[0] : 'project'
    bySection.set(section, (bySection.get(section) || 0) + (size || 0))
  }
  return [...bySection.entries()].sort((a, b) => b[1] - a[1]).map(([section, bytes]) => ({ section, bytes }))
}

// The one byte formatter (core/formatBytes.js), re-exported for existing importers.
export { formatBytes }

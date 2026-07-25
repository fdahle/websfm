// `.websfm` project file I/O — the impure half of core/io/projectArchive.js.
// Owns the zip library (fflate), OPFS reads/writes, and the File System Access
// save target. Everything about *what* goes in the archive is in the core module.
//
// Both directions are STREAMING and that is load-bearing: a project is mostly
// source images, so a 3 GB export must never be assembled in memory. Export
// reads one OPFS file at a time and flushes zip output to the sink between
// chunks; import pushes the source file's stream through the unzipper and drains
// completed entries to OPFS between pushes. Peak memory is one entry, not one
// archive.

import { Zip, ZipDeflate, ZipPassThrough, Unzip, UnzipInflate, UnzipPassThrough } from 'fflate'
import * as opfs from './opfs.js'
import {
  MANIFEST_NAME, shouldArchivePath, archiveCompression, archiveSizeVerdict,
  isSafeArchiveEntry, validateManifest, formatBytes, summarizeSections,
  ARCHIVE_DERIVED_DIRS,
  ZIP32_MAX_BYTES,
} from '../core/io/projectArchive.js'

// ── Save target ───────────────────────────────────────────────────────────────
// `showSaveFilePicker` streams straight to disk at constant memory and is the
// only way a multi-GB export is viable. Firefox/Safari have no picker, so they
// fall back to buffering the archive and handing it to an <a download> — which
// is why the size pre-flight matters more there.

async function openArchiveSink(suggestedName) {
  if (typeof window !== 'undefined' && window.showSaveFilePicker) {
    let handle
    try {
      handle = await window.showSaveFilePicker({
        suggestedName,
        types: [{ description: 'websfm project', accept: { 'application/zip': ['.websfm'] } }],
      })
    } catch (err) {
      if (err?.name === 'AbortError') return null   // user cancelled — not an error
      handle = null                                  // picker unavailable/blocked: buffer instead
    }
    if (handle) {
      const writable = await handle.createWritable()
      return {
        streaming: true,
        write: (chunk) => writable.write(chunk),
        close: () => writable.close(),
        abort: () => writable.abort?.().catch(() => {}),
      }
    }
  }
  const chunks = []
  return {
    streaming: false,
    // fflate reuses its output buffer between callbacks, so a buffered sink must
    // copy — keeping the view alive would leave every chunk pointing at the last.
    write: (chunk) => { chunks.push(chunk.slice()) },
    close: async () => {
      const blob = new Blob(chunks, { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = suggestedName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
    abort: () => { chunks.length = 0 },
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

// Collect the entry list first (File handles are lazy — `size` costs no read).
// Two passes buy an exact total for the size pre-flight and for progress, and a
// pruned walk when derived data is excluded.
async function collectEntries(projectId, includeDerived) {
  const skip = includeDerived
    ? null
    : (relPath, kind) => kind === 'directory' && ARCHIVE_DERIVED_DIRS.includes(relPath)
  const entries = []
  let totalBytes = 0
  for await (const { relPath, file } of opfs.walkProjectFiles(projectId, { skip })) {
    if (!shouldArchivePath(relPath, { includeDerived })) continue
    entries.push({ relPath, file, size: file.size })
    totalBytes += file.size
  }
  entries.sort((a, b) => a.relPath.localeCompare(b.relPath))
  return { entries, totalBytes }
}

/**
 * Write one project's directory tree to a `.websfm` file.
 * Returns { cancelled } when the user dismissed the save dialog, else
 * { fileName, entryCount, sourceBytes, archiveBytes }.
 */
export async function exportProjectArchive({
  projectId, manifest, fileName, includeDerived = true, onProgress = null, onLog = null,
  // Injected in tests (and by a future folder-target export) so the zip writer can
  // be exercised without a save dialog. Default: the File System Access picker,
  // falling back to a buffered download.
  openSink = openArchiveSink,
}) {
  const log = (m, level = 'info') => onLog?.(m, level, 'Project')

  const { entries, totalBytes } = await collectEntries(projectId, includeDerived)
  if (!entries.length) throw new Error('project has no saved data to export')

  const verdict = archiveSizeVerdict(totalBytes)
  if (!verdict.ok) throw new Error(verdict.error)

  log(`Saving project: ${entries.length} files, ${formatBytes(totalBytes)}`
    + `${includeDerived ? '' : ' (cached/derived data excluded)'}`)
  for (const { section, bytes } of summarizeSections(entries)) {
    log(`  ${section}: ${formatBytes(bytes)}`, 'debug')
  }

  const sink = await openSink(fileName)
  if (!sink) { log('Save cancelled'); return { cancelled: true } }

  let archiveBytes = 0
  let zipError = null
  const queued = []
  const zip = new Zip((err, chunk, final) => {
    if (err) { zipError = err; return }
    if (chunk?.length) { archiveBytes += chunk.length; queued.push(chunk) }
    if (final) queued.push(null)
  })

  // fflate's callback is synchronous; the sink is async. Drain between pushes so
  // back-pressure is real and `queued` never grows past one file's output.
  async function drain() {
    if (zipError) throw zipError
    while (queued.length) {
      const chunk = queued.shift()
      if (chunk === null) break   // end-of-archive marker
      await sink.write(chunk)
    }
    if (zipError) throw zipError
  }

  async function addEntry(name, source) {
    const method = archiveCompression(name)
    const entry = method === 8 ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name)
    zip.add(entry)
    if (source instanceof Uint8Array) {
      entry.push(source, true)
      await drain()
      return
    }
    // Stream the file rather than materialising it — a single scan can be 200 MB.
    const reader = source.stream().getReader()
    for (;;) {
      const { done, value } = await reader.read()
      if (done) { entry.push(new Uint8Array(0), true); break }
      entry.push(value, false)
      await drain()
    }
    await drain()
  }

  try {
    // Manifest first, so an import can recognise and reject the file after
    // reading only its first few kilobytes.
    await addEntry(MANIFEST_NAME, new TextEncoder().encode(JSON.stringify(manifest, null, 2)))

    let done = 0
    for (const { relPath, file } of entries) {
      await addEntry(relPath, file)
      done++
      onProgress?.({ done, total: entries.length, label: relPath })
    }
    zip.end()
    await drain()
    await sink.close()
  } catch (err) {
    await sink.abort()
    throw err
  }

  log(`Project saved to ${fileName}: ${formatBytes(archiveBytes)} `
    + `(${entries.length + 1} entries, from ${formatBytes(totalBytes)})`)
  return { fileName, entryCount: entries.length + 1, sourceBytes: totalBytes, archiveBytes }
}

// ── Import ────────────────────────────────────────────────────────────────────

const DEFAULT_IMPORT_LIMITS = Object.freeze({
  maxEntries: 100_000,
  maxEntryBytes: 1024 * 1024 * 1024, // one expanded entry is buffered at a time
  maxTotalBytes: ZIP32_MAX_BYTES,
  maxCompressionRatio: 1000,
  maxManifestBytes: 1024 * 1024,
})

function makeUnzip(onEntry, limits = {}) {
  const cfg = { ...DEFAULT_IMPORT_LIMITS, ...limits }
  const unzip = new Unzip()
  let entryCount = 0
  let totalBytes = 0
  unzip.register(UnzipInflate)
  unzip.register(UnzipPassThrough)
  unzip.onfile = (f) => {
    entryCount++
    if (entryCount > cfg.maxEntries) throw new Error(`project file has too many entries (limit ${cfg.maxEntries})`)
    const entryLimit = f.name === MANIFEST_NAME ? cfg.maxManifestBytes : cfg.maxEntryBytes
    if (Number.isFinite(f.originalSize) && f.originalSize > entryLimit) {
      throw new Error(`archive entry "${f.name}" expands to ${formatBytes(f.originalSize)} `
        + `(limit ${formatBytes(entryLimit)})`)
    }
    if (Number.isFinite(f.originalSize) && Number.isFinite(f.size) && f.size > 0
        && f.originalSize / f.size > cfg.maxCompressionRatio) {
      throw new Error(`archive entry "${f.name}" has an unsafe compression ratio`)
    }
    const chunks = []
    let bytes = 0
    f.ondata = (err, chunk, final) => {
      if (err) throw err
      if (chunk?.length) {
        bytes += chunk.length
        totalBytes += chunk.length
        if (bytes > entryLimit) throw new Error(`archive entry "${f.name}" exceeds ${formatBytes(entryLimit)}`)
        if (totalBytes > cfg.maxTotalBytes) {
          throw new Error(`project file expands beyond the ${formatBytes(cfg.maxTotalBytes)} import limit`)
        }
        chunks.push(chunk.slice())
      }
      if (final) onEntry({ name: f.name, chunks, bytes })
    }
    f.start()
  }
  return unzip
}

/**
 * Read just enough of the head of a file to find and validate its manifest,
 * WITHOUT writing anything. Export always puts the manifest first, so this
 * succeeds on our own archives after a few kB. A foreign zip (a COLMAP model,
 * say) simply yields null and routes elsewhere.
 */
export async function peekArchiveManifest(file, { maxBytes = 4 * 1024 * 1024 } = {}) {
  let found = null
  let unzip
  try {
    unzip = makeUnzip(({ name, chunks }) => {
      if (name !== MANIFEST_NAME || found) return
      try { found = JSON.parse(new TextDecoder().decode(concat(chunks))) } catch { found = null }
    })
  } catch { return null }

  const head = new Uint8Array(await file.slice(0, Math.min(maxBytes, file.size)).arrayBuffer())
  const CHUNK = 256 * 1024
  try {
    for (let off = 0; off < head.length && !found; off += CHUNK) {
      const end = Math.min(off + CHUNK, head.length)
      unzip.push(head.subarray(off, end), end >= file.size)
    }
  } catch {
    return found   // truncated tail is expected — we only fed the head
  }
  return found
}

function concat(chunks) {
  let n = 0
  for (const c of chunks) n += c.length
  const out = new Uint8Array(n)
  let o = 0
  for (const c of chunks) { out.set(c, o); o += c.length }
  return out
}

/**
 * Unpack a `.websfm` file into `projectId`'s (fresh) OPFS directory.
 * Returns { manifest, entryCount, bytes }. Throws with a user-facing message on
 * a bad manifest — the caller is responsible for deleting the half-written dir.
 */
export async function importProjectArchive({
  file, projectId, onProgress = null, onLog = null, limits = {},
}) {
  const log = (m, level = 'info') => onLog?.(m, level, 'Project')

  let manifest = null
  let entryCount = 0
  let bytes = 0
  let skipped = 0
  const pending = []

  // Keep decompression within both the ZIP32 format ceiling and the browser's
  // currently available storage. A folder project remains the escape hatch for
  // exceptionally large individual source files.
  let available = Infinity
  try {
    const estimate = await opfs.getQuota?.()
    if (Number.isFinite(estimate?.quota)) {
      available = Math.max(0, estimate.quota - (estimate.usage || 0))
    }
  } catch {}
  const maxTotalBytes = Math.min(
    limits.maxTotalBytes ?? DEFAULT_IMPORT_LIMITS.maxTotalBytes,
    Number.isFinite(available) ? Math.floor(available * 0.9) : Infinity,
  )
  if (maxTotalBytes <= 0) throw new Error('browser storage has no space available for this project')
  const unzip = makeUnzip((entry) => pending.push(entry), { ...limits, maxTotalBytes })

  async function drain() {
    while (pending.length) {
      const { name, chunks, bytes: size } = pending.shift()
      if (name === MANIFEST_NAME) {
        try { manifest = JSON.parse(new TextDecoder().decode(concat(chunks))) } catch { manifest = null }
        const v = validateManifest(manifest)
        if (!v.ok) throw new Error(v.error)
        continue
      }
      if (!isSafeArchiveEntry(name)) { skipped++; continue }
      await opfs.writeProjectFile(projectId, name, new Blob(chunks))
      entryCount++
      bytes += size
      onProgress?.({ done: entryCount, total: null, label: name })
    }
  }

  const reader = file.stream().getReader()
  for (;;) {
    const { done, value } = await reader.read()
    unzip.push(done ? new Uint8Array(0) : value, done)
    await drain()
    if (done) break
  }

  if (!manifest) throw new Error('not a websfm project file (no manifest.json)')
  if (skipped) log(`Skipped ${skipped} archive ${skipped === 1 ? 'entry' : 'entries'} with unsafe paths`, 'warn')
  log(`Loaded ${entryCount} files (${formatBytes(bytes)}) from project file`)
  return { manifest, entryCount, bytes }
}

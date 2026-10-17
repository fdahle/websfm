// `.websfm` project file I/O — the impure half of core/io/projectArchive.js.
// Owns the archive format (through utils/zip.js), OPFS reads/writes, and the File System Access
// save target. Everything about *what* goes in the archive is in the core module.
//
// Neither direction holds the archive in memory, and that is load-bearing: a project
// is mostly source images, so a multi-GB export must never be assembled in memory.
// Export writes one OPFS file at a time to the sink (a quick CRC pass, then the
// bytes), ZIP64 past 4 GiB (utils/zip.js). Import reads the archive's central
// directory and copies each entry to OPFS as a slice of the file; only a deflated
// (JSON) entry is decompressed, and it is small. Archives from the earlier fflate
// writer read the same way.

import * as opfs from './opfs.js'
import { zipLocalHeader, zipCentralHeader, zipEndRecords, crc32, crc32Blob, readZipIndex, zipEntryBlob } from './zip.js'
import {
  MANIFEST_NAME, shouldArchivePath, archiveCompression, archiveSizeVerdict,
  isSafeArchiveEntry, validateManifest, formatBytes, summarizeSections,
  ARCHIVE_DERIVED_DIRS,
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
      // The one createWritable outside opfs.js, deliberately: this is a file the
      // user just picked, written once, streamed, and never touched by anything
      // else — none of the conditions opfs.js's per-path write queue exists for.
      const writable = await handle.createWritable()
      return {
        streaming: true,
        write: (chunk) => writable.write(chunk),
        close: () => writable.close(),
        abort: () => writable.abort?.().catch(() => {}),
      }
    }
  }
  // No save dialog (Firefox, Safari): the archive is gathered into a Blob 64 MB at a
  // time, which the browser may keep on disk, rather than as copies held in the page —
  // an 18 GB project held as ArrayBuffers ran the page out of memory ~11 GB in, and
  // the next file read failed with NotReadableError (quarry, 2026-10-17).
  let blob = new Blob([]), batch = [], batchBytes = 0
  const seal = () => { if (batch.length) { blob = new Blob([blob, ...batch]); batch = []; batchBytes = 0 } }
  return {
    streaming: false,
    // Copy: a stream reader may hand out views of a buffer it reuses.
    write: (chunk) => {
      batch.push(chunk.slice()); batchBytes += chunk.byteLength
      if (batchBytes >= 64 * 1024 * 1024) seal()
    },
    close: async () => {
      seal()
      blob = new Blob([blob], { type: 'application/zip' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = suggestedName
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 60_000)
    },
    abort: () => { blob = new Blob([]); batch = []; batchBytes = 0 },
  }
}

// ── Export ────────────────────────────────────────────────────────────────────

// Collect the entry list first (File handles are lazy — `size` costs no read).
// Two passes buy an exact total for the size pre-flight and for progress, and a
// pruned walk when derived data is excluded.
// Archived files up to this size are read into memory once (see the export loop).
const SNAPSHOT_IN_MEMORY_BYTES = 64 * 1024 * 1024

async function collectEntries(projectId, includeDerived) {
  const skip = includeDerived
    ? null
    : (relPath, kind) => kind === 'directory' && ARCHIVE_DERIVED_DIRS.includes(relPath)
  const entries = []
  let totalBytes = 0
  for await (const { relPath, file, handle } of opfs.walkProjectFiles(projectId, { skip })) {
    if (!shouldArchivePath(relPath, { includeDerived })) continue
    entries.push({ relPath, file, handle, size: file.size })
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
  const enc = new TextEncoder()
  const central = []
  const write = async (bytes) => { await sink.write(bytes); archiveBytes += bytes.length }

  // One entry: sizes and CRC known before its local header (a deflated JSON is
  // compressed in memory; a stored file gets a CRC pass first), so the archive has no
  // data descriptors and any reader, streaming or not, can read it.
  async function addEntry(name, source) {
    const method = archiveCompression(name)
    const nameBytes = enc.encode(name)
    let crc, size, data
    if (method === 8) {
      const raw = source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer())
      crc = crc32(raw); size = raw.length
      data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
    } else {
      data = source instanceof Uint8Array ? new Blob([source]) : source
      size = data.size
      crc = await crc32Blob(data)
    }
    const compressedSize = data instanceof Blob ? data.size : data.length
    const offset = archiveBytes
    await write(zipLocalHeader(nameBytes, { crc, size, compressedSize, method }))
    if (data instanceof Blob) {
      // Stream the file rather than materialising it — a single scan can be 200 MB.
      const reader = data.stream().getReader()
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        await write(value)
      }
    } else await write(data)
    central.push(zipCentralHeader(nameBytes, { crc, size, compressedSize, offset, method }))
  }

  try {
    // Manifest first  try {
    // Manifest first, so an import can recognise and reject the file after
    // reading only its first few kilobytes.
    await addEntry(MANIFEST_NAME, new TextEncoder().encode(JSON.stringify(manifest, null, 2)))

    // A File is a snapshot: one taken at the walk is unreadable once the project
    // writes that file again (a save, a cloud generation) — and a large save takes
    // minutes. Take each file's snapshot when it is archived; read one that fits in
    // memory once, so its checksum and its bytes come from the same version. A file
    // gone by then was superseded (an old save generation); it is left out and said so.
    let done = 0, skipped = 0
    for (const { relPath, file, handle } of entries) {
      let current = file
      if (handle) {
        try { current = await handle.getFile() } catch (err) {
          if (err?.name !== 'NotFoundError') throw err
          skipped++
          log(`  ${relPath} was removed while saving (superseded) — left out`, 'debug')
          continue
        }
      }
      try {
        await addEntry(relPath, current.size <= SNAPSHOT_IN_MEMORY_BYTES && archiveCompression(relPath) !== 8
          ? new Uint8Array(await current.arrayBuffer()) : current)
      } catch (err) {
        // Name the file: "could not be read" alone says nothing about where.
        const named = new Error(`${relPath} (${(current.size / 1024 ** 2).toFixed(1)} MB): ${err?.message ?? err}`)
        named.name = err?.name ?? 'Error'
        named.cause = err
        throw named
      }
      done++
      onProgress?.({ done, total: entries.length, label: relPath })
    }
    if (skipped) log(`Saving project: ${skipped} file(s) were replaced while saving and are left out`, 'info')
    const cdOffset = archiveBytes
    let cdSize = 0
    for (const h of central) { await write(h); cdSize += h.length }
    await write(zipEndRecords(central.length, cdOffset, cdSize))
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
  maxDeflatedEntryBytes: 1024 * 1024 * 1024, // a deflated entry is decompressed whole
  maxTotalBytes: Infinity,                   // storage is checked by the writes themselves (see importProjectArchive)
  maxCompressionRatio: 1000,
  maxManifestBytes: 1024 * 1024,
})

// The archive's entries (central directory), checked against the limits before
// anything is written. Throws with a user-facing reason.
async function archiveIndex(file, limits) {
  const cfg = { ...DEFAULT_IMPORT_LIMITS, ...limits }
  let entries
  try { entries = await readZipIndex(file) } catch (err) { throw new Error(`not a readable project file (${err.message})`) }
  if (entries.length > cfg.maxEntries) throw new Error(`project file has too many entries (limit ${cfg.maxEntries})`)
  let total = 0
  for (const e of entries) {
    const limit = e.name === MANIFEST_NAME ? cfg.maxManifestBytes : e.method === 8 ? cfg.maxDeflatedEntryBytes : Infinity
    if (e.size > limit) throw new Error(`archive entry "${e.name}" expands to ${formatBytes(e.size)} (limit ${formatBytes(limit)})`)
    if (e.method === 8 && e.compressedSize > 0 && e.size / e.compressedSize > cfg.maxCompressionRatio) {
      throw new Error(`archive entry "${e.name}" has an unsafe compression ratio`)
    }
    total += e.size
  }
  if (total > cfg.maxTotalBytes) throw new Error(`project file expands to ${formatBytes(total)}, beyond the ${formatBytes(cfg.maxTotalBytes)} available`)
  return { entries, total }
}

async function readManifest(file, entries) {
  const e = entries.find((x) => x.name === MANIFEST_NAME)
  if (!e) return null
  try { return JSON.parse(await (await zipEntryBlob(file, e)).text()) } catch { return null }
}

/**
 * Read just the manifest of a file, WITHOUT writing anything: the archive's central
 * directory, then that one entry. A foreign zip (a COLMAP model, say) or a non-zip
 * simply yields null and routes elsewhere.
 */
export async function peekArchiveManifest(file) {
  try {
    const entries = await readZipIndex(file)
    return await readManifest(file, entries)
  } catch { return null }
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

  // The browser's storage estimate is not a ceiling: Chrome reports quota = usage +
  // 10 GiB and raises it as the site writes (measured 2026-10-17: 12.9 GB written →
  // 23.6 GB quota), so refusing an archive larger than quota − usage refused a 14 GB
  // project the same browser had just stored. Say so when the project looks larger;
  // a write that really runs out of space fails with the storage-full message
  // (opfs.js) and the caller removes the half-written project.
  const maxTotalBytes = limits.maxTotalBytes ?? DEFAULT_IMPORT_LIMITS.maxTotalBytes
  const { entries } = await archiveIndex(file, { ...limits, maxTotalBytes })
  try {
    const estimate = await opfs.getQuota?.()
    const expanded = entries.reduce((n, e) => n + (e.size ?? 0), 0)
    const available = Number.isFinite(estimate?.quota) ? Math.max(0, estimate.quota - (estimate.usage || 0)) : Infinity
    if (expanded > available) {
      log(`Opening project: it expands to ${formatBytes(expanded)}, more than the ${formatBytes(available)} the browser `
        + 'reports free; continuing (the browser usually grants more as the project is written). If storage runs out, '
        + 'the open stops and nothing is left behind.', 'warn')
    }
  } catch { /* no estimate: nothing to say */ }

  const manifest = await readManifest(file, entries)
  if (!manifest) throw new Error('not a websfm project file (no manifest.json)')
  const v = validateManifest(manifest)
  if (!v.ok) throw new Error(v.error)

  let entryCount = 0, bytes = 0, skipped = 0
  for (const e of entries) {
    if (e.name === MANIFEST_NAME || e.name.endsWith('/')) continue
    if (!isSafeArchiveEntry(e.name)) { skipped++; continue }
    // A stored entry goes to OPFS as a slice of the file: never read into memory.
    await opfs.writeProjectFile(projectId, e.name, await zipEntryBlob(file, e))
    entryCount++
    bytes += e.size
    onProgress?.({ done: entryCount, total: entries.length - 1, label: e.name })
  }

  if (!manifest) throw new Error('not a websfm project file (no manifest.json)')
  if (skipped) log(`Skipped ${skipped} archive ${skipped === 1 ? 'entry' : 'entries'} with unsafe paths`, 'warn')
  log(`Loaded ${entryCount} files (${formatBytes(bytes)}) from project file`)
  return { manifest, entryCount, bytes }
}

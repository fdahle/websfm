// `.websfm` project file I/O — the impure half of core/io/projectArchive.js.
// Owns the archive format (through utils/zip.js), OPFS reads/writes, and the File System Access
// save target. Everything about *what* goes in the archive is in the core module.
//
// Neither direction holds the archive in memory, and that is load-bearing: a project
// is mostly source images, so a multi-GB export must never be assembled in memory.
// Export writes one OPFS file at a time to the sink (a quick CRC pass, then the
// bytes), ZIP64 past 4 GiB (utils/zip.js); a binary document (a metadata file and its
// generation files) goes in as one generation, under its save lock, so a save that
// lands while the archive is written cannot split it. Import reads the archive's central
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
import { pluralize } from '../core/textFormat.js'

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

  // One entry, in two halves. `prepareEntry` reads everything the entry needs before a
  // byte of it is written: sizes and CRC, and the bytes themselves of a deflated (JSON)
  // or small file, so the archive has no data descriptors and any reader, streaming or
  // not, can read it. A failure there leaves the archive untouched, so the caller can
  // retry from a fresh snapshot. `writeEntry` then writes it; a large file is streamed
  // a second time, and a failure part-way cannot be undone.
  async function prepareEntry(name, source) {
    const method = archiveCompression(name)
    if (method === 8) {
      const raw = source instanceof Uint8Array ? source : new Uint8Array(await source.arrayBuffer())
      const data = new Uint8Array(await new Response(new Blob([raw]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer())
      return { name, method, crc: crc32(raw), size: raw.length, data }
    }
    // A file that fits in memory is read once, so its checksum and its bytes are the
    // same version even if the project writes it again meanwhile.
    const data = source instanceof Uint8Array ? source
      : source.size <= SNAPSHOT_IN_MEMORY_BYTES ? new Uint8Array(await source.arrayBuffer()) : source
    return { name, method, crc: data instanceof Uint8Array ? crc32(data) : await crc32Blob(data), size: data.size ?? data.length, data }
  }

  async function writeEntry({ name, method, crc, size, data }) {
    const nameBytes = enc.encode(name)
    const compressedSize = data instanceof Blob ? data.size : data.length
    const offset = archiveBytes
    await write(zipLocalHeader(nameBytes, { crc, size, compressedSize, method }))
    if (data instanceof Blob) {
      // Stream the file rather than materialising it — a single scan can be 200 MB.
      try {
        const reader = data.stream().getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          await write(value)
        }
      } catch (err) {
        if (!isStaleSnapshot(err)) throw err
        const changed = new Error(`${name} was rewritten while the project was being saved, after part of it was `
          + 'already written, so the project file cannot be finished. Save again once no step is running.')
        changed.name = err.name
        changed.cause = err
        throw changed
      }
    } else await write(data)
    central.push(zipCentralHeader(nameBytes, { crc, size, compressedSize, offset, method }))
  }

  // A named error: "could not be read" alone says nothing about where.
  const namedError = (relPath, size, err) => {
    if (err?.cause && err.message.startsWith(relPath)) return err
    const e = new Error(`${relPath} (${(size / 1024 ** 2).toFixed(1)} MB): ${err?.message ?? err}`)
    e.name = err?.name ?? 'Error'
    e.cause = err
    return e
  }

  // A File is a snapshot: one taken at the walk is unreadable once the project writes
  // that file again (a depth map's filter pass, a cloud's octree) — and a large save
  // takes minutes. Take each file's snapshot when it is archived; one that went stale
  // before any of it was written is taken again. A file gone by then was superseded;
  // it is left out and said so. → false when left out.
  async function archiveFile(relPath, handle, file) {
    for (let attempt = 0; ; attempt++) {
      let current = file
      if (handle) {
        try { current = await handle.getFile() } catch (err) {
          if (err?.name !== 'NotFoundError') throw namedError(relPath, file.size, err)
          log(`  ${relPath} was removed while saving (superseded) — left out`, 'debug')
          return false
        }
      }
      let entry
      try {
        entry = await prepareEntry(relPath, current)
      } catch (err) {
        if (handle && attempt < 2 && isStaleSnapshot(err)) {
          log(`  ${relPath} changed while saving — reading it again`, 'debug')
          continue
        }
        throw namedError(relPath, current.size, err)
      }
      try { await writeEntry(entry) } catch (err) { throw namedError(relPath, current.size, err) }
      return true
    }
  }

  // A binary document (reconstruction.json, matches/matches.json, products/*.json)
  // goes in as one generation: under the lock its saves hold, its metadata as it is now
  // and exactly the files that metadata names (opfs.js, "Binary documents as one
  // unit"). The walk's own copies of its generation files are not used: by now they
  // may belong to an earlier save, or be collected. → the number of entries written.
  const dec = new TextDecoder()
  async function archiveBinaryDocument(relPath) {
    return opfs.withBinaryDocumentLock(projectId, relPath, async () => {
      const metaFile = await opfs.getProjectFile(projectId, relPath)
      if (!metaFile) {
        log(`  ${relPath} was removed while saving — left out`, 'debug')
        return 0
      }
      const metaBytes = new Uint8Array(await metaFile.arrayBuffer())
      let listed = []
      try { listed = Object.values(JSON.parse(dec.decode(metaBytes))?.binaryFiles ?? {}) } catch { /* archived as it is */ }
      const dir = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/') + 1) : ''
      const files = [], seen = new Set()
      for (const f of listed) {
        if (!f?.name || /[/\\]/.test(f.name) || seen.has(f.name)) continue
        seen.add(f.name)
        const file = await opfs.getProjectFile(projectId, dir + f.name)
        if (!file || file.size !== f.bytes) {
          // Not a race (no save runs under this lock): the project itself lacks it.
          log(`  ${relPath} names ${dir + f.name}, which is ${file ? `${file.size} bytes, not ${f.bytes}` : 'missing'} `
            + 'in the project — saved as it is', 'warn')
          if (!file) continue
        }
        files.push({ relPath: dir + f.name, file })
      }
      await writeEntry(await prepareEntry(relPath, metaBytes))
      for (const { relPath: p, file } of files) {
        try { await writeEntry(await prepareEntry(p, file)) } catch (err) { throw namedError(p, file.size, err) }
      }
      return 1 + files.length
    })
  }

  try {
    // Manifest first, so an import can recognise and reject the file after
    // reading only its first few kilobytes.
    await writeEntry(await prepareEntry(MANIFEST_NAME, enc.encode(JSON.stringify(manifest, null, 2))))

    const items = entries.filter((e) => !opfs.binaryDocumentOf(e.relPath))
    let done = 0, skipped = 0
    for (const { relPath, file, handle } of items) {
      if (opfs.binaryDocumentLockKey(projectId, relPath)) {
        if (!(await archiveBinaryDocument(relPath))) skipped++
      } else if (!(await archiveFile(relPath, handle, file))) skipped++
      done++
      onProgress?.({ done, total: items.length, label: relPath })
    }
    if (skipped) log(`Saving project: left out ${pluralize(skipped, 'file')} that changed while saving`, 'info')
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
    + `(${central.length} entries, from ${formatBytes(totalBytes)})`)
  return { fileName, entryCount: central.length, sourceBytes: totalBytes, archiveBytes }
}

// A File snapshot that went stale: the file was rewritten (NotReadableError) or removed.
const isStaleSnapshot = (err) => err?.name === 'NotReadableError' || err?.name === 'NotFoundError'

// ── Import ────────────────────────────────────────────────────────────────────

const DEFAULT_IMPORT_LIMITS = Object.freeze({
  // The export has no entry limit (ZIP64 past 65,535): a project keeps about ten files
  // per image (quarry: 3,495 for 347), so this admits ~400k images. It is a bound on the
  // central directory read, not the bomb guard — the size and ratio limits below are.
  maxEntries: 4_000_000,
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

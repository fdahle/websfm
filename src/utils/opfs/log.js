// The developer console's persisted log.
import { trackPersistence, ignoreMissing } from '../persistence.js'
import { getProjectDir, writeFileIn } from './base.js'

// ── Dev console log ──────────────────────────────────────────────────────────────
// Append-only NDJSON stream (`log.ndjson`): one { id, time, level, message,
// source } object per line. The console keeps only a bounded live *tail* in
// memory (SfM runs are verbose — thousands of lines); the file is the full
// record, so scroll-back and TXT export read from it rather than memory.
// Callers must serialise appends (≤1 in flight) — see useLogStore — since each
// append reads the current size to seek to the end.

export async function appendLog(projectId, entries) {
  return trackPersistence('appendLog:' + String(projectId), async () => {
    if (!entries || entries.length === 0) return
    const dir = await getProjectDir(projectId, true)
    await writeFileIn(dir, 'log.ndjson', entries.map((e) => JSON.stringify(e)).join('\n') + '\n', { append: true })
  })
}

export async function readLog(projectId) {
  try {
    const dir = await getProjectDir(projectId)
    const fh = await dir.getFileHandle('log.ndjson')
    const text = await (await fh.getFile()).text()
    const out = []
    for (const line of text.split('\n')) {
      if (!line) continue
      try {
        out.push(JSON.parse(line))
      } catch (error) {
        ignoreMissing(error)
      }
    }
    return out
  } catch {
    return null
  }
}

// Read only the live console window from the end of the append-only stream.
// Export/scroll-back still use readLog(), which deliberately returns everything.
export async function readLogTail(projectId, limit) {
  try {
    const dir = await getProjectDir(projectId)
    const fh = await dir.getFileHandle('log.ndjson')
    const file = await fh.getFile()
    if (!file.size || limit <= 0) return []
    let bytes = Math.min(file.size, Math.max(64 * 1024, limit * 256))
    while (true) {
      const start = file.size - bytes
      const text = await file.slice(start).text()
      const lines = text.split('\n')
      if (start > 0) lines.shift()
      const out = []
      for (const line of lines) {
        if (!line) continue
        try {
          out.push(JSON.parse(line))
        } catch (error) {
          ignoreMissing(error)
        }
      }
      if (out.length >= limit || start === 0) return out.slice(-limit)
      bytes = Math.min(file.size, bytes * 2)
    }
  } catch {
    return null
  }
}

export async function truncateLog(projectId) {
  return trackPersistence('truncateLog:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId, true)
      await writeFileIn(dir, 'log.ndjson', null) // no keepExistingData ⇒ truncates
    } catch (error) {
      ignoreMissing(error)
    }
  })
}

export async function deleteLog(projectId) {
  return trackPersistence('deleteLog:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('log.ndjson')
    } catch (error) {
      ignoreMissing(error)
    }
  })
}

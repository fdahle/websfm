import { Unzip, UnzipInflate } from 'fflate'

export const ZIP_LIMITS = { compressed: 1024 ** 3, expanded: 512 * 1024 ** 2, entry: 256 * 1024 ** 2, entries: 20_000, ratio: 200 }
export function safeZipPath(name) {
  const path = name.replace(/\\/g, '/')
  if (!path || path.startsWith('/') || /^[a-z]:/i.test(path) || path.includes('\0')
      || path.split('/').some(p => p === '..' || p === '.')) throw new Error('Unsafe ZIP entry path')
  return path
}

// Feed small compressed chunks: even dishonest size headers cannot request an
// unbounded inflate allocation. Called in a dedicated, cancellable worker.
export async function readBoundedZip(file, select, limits = ZIP_LIMITS) {
  if (file.size > limits.compressed) throw new Error('ZIP exceeds the compressed-size limit')
  const entries = [], names = [], seen = new Set()
  let expanded = 0, pending = 0, error = null
  const unzip = new Unzip(entry => {
    const path = safeZipPath(entry.name)
    if (seen.has(path)) throw new Error(`Duplicate ZIP entry: ${path}`)
    seen.add(path)
    if (seen.size > limits.entries) throw new Error('ZIP has too many entries')
    names.push(path)
    if (!select(path) || path.endsWith('/')) return
    if (entry.originalSize > limits.entry
        || (entry.size > 0 && entry.originalSize / entry.size > limits.ratio)) {
      throw new Error('ZIP entry exceeds size or compression-ratio limit')
    }
    pending++
    let length = 0
    const chunks = []
    entry.ondata = (err, chunk, final) => {
      if (err) { error = err; return }
      length += chunk.length; expanded += chunk.length
      if (length > limits.entry || expanded > limits.expanded
          || expanded > Math.max(file.size, 1) * limits.ratio) {
        error = new Error('ZIP expansion exceeds the working-memory limit')
        entry.terminate()
        throw error
      }
      chunks.push(chunk)
      if (final) {
        const data = new Uint8Array(length)
        let offset = 0
        for (const c of chunks) { data.set(c, offset); offset += c.length }
        entries.push({ path, data })
        pending--
      }
    }
    entry.start()
  })
  unzip.register(UnzipInflate)
  const reader = file.stream().getReader()
  try {
    while (true) {
      const { value, done } = await reader.read()
      if (done) break
      for (let i = 0; i < value.length; i += 1024) {
        unzip.push(value.subarray(i, i + 1024))
        if (error) throw error
      }
    }
    unzip.push(new Uint8Array(0), true)
    if (error) throw error
    if (pending) throw new Error('Truncated ZIP entry')
    return { entries, names }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock() }
}

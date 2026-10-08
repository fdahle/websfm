// A binary document commits by replacing ONE metadata file after writing immutable
// generation files. Readers/writers hold the same lock through buffer hydration.
// Failed writes leave the previous document intact. Orphan files are removed by
// the next successful save, never before its commit.
//
// A buffer may instead be `{ reuse: { name, bytes } }`: an immutable file an earlier
// commit already wrote, carried into this generation without being rewritten. That is
// what keeps a save proportional to what changed (one edited cloud) rather than to
// everything the document holds. Reuse is checked before anything is written: if any
// such file is missing or has the wrong size (another tab's save collected it), the
// call writes nothing and returns `{ stale: [keys] }` so the caller can resend those
// buffers. Otherwise it returns `{ files }`, the committed key → { name, bytes } map.
export async function writeBinaryDocument(dir, filename, metadata, buffers, { writeJson, writeBin }) {
  const stale = []
  for (const [key, buffer] of Object.entries(buffers)) {
    if (buffer?.reuse && !(await fileHasSize(dir, buffer.reuse))) stale.push(key)
  }
  if (stale.length) return { stale }

  const generation = crypto.randomUUID()
  const files = {}
  for (const [key, buffer] of Object.entries(buffers)) {
    if (buffer == null) continue
    if (buffer.reuse) { files[key] = { name: buffer.reuse.name, bytes: buffer.reuse.bytes }; continue }
    const name = `${filename}.${generation}.${key}.bin`
    await writeBin(dir, name, buffer)
    files[key] = { name, bytes: buffer.byteLength }
  }
  await writeJson(dir, filename, { ...metadata, binaryFiles: files })
  if (dir.keys) {
    const keep = new Set(Object.values(files).map(f => f.name))
    for await (const name of dir.keys()) {
      if (name.startsWith(`${filename}.`) && name.endsWith('.bin') && !keep.has(name)) {
        // Garbage collection is best effort; the committed document is already safe.
        await dir.removeEntry(name).catch(() => {})
      }
    }
  }
  return { files }
}

async function fileHasSize(dir, file) {
  if (!file?.name || /[/\\]/.test(file.name) || !Number.isSafeInteger(file.bytes)) return false
  try {
    return (await (await dir.getFileHandle(file.name)).getFile()).size === file.bytes
  } catch {
    return false
  }
}

export async function readBinaryDocument(dir, metadata, readBin) {
  const buffers = {}
  for (const [key, file] of Object.entries(metadata.binaryFiles)) {
    if (!file.name || /[/\\]/.test(file.name) || !Number.isSafeInteger(file.bytes) || file.bytes < 0) {
      throw new Error('Invalid binary document manifest')
    }
    const buffer = await readBin(dir, file.name)
    if (buffer.byteLength !== file.bytes) throw new Error(`Incomplete saved buffer: ${key}`)
    buffers[key] = buffer
  }
  return buffers
}

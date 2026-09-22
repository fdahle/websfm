// A binary document commits by replacing ONE metadata file after writing immutable
// generation files. Readers/writers hold the same lock through buffer hydration.
// Failed writes leave the previous document intact. Orphan files are removed by
// the next successful save, never before its commit.
export async function writeBinaryDocument(dir, filename, metadata, buffers, { writeJson, writeBin }) {
  const generation = crypto.randomUUID()
  const files = {}
  for (const [key, buffer] of Object.entries(buffers)) {
    if (buffer == null) continue
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

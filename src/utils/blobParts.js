// Blob side of the chunked export/import path (core/io/parts.js is the pure side).
// Works in the page and in workers: Blob, slice and arrayBuffer are all there.

// Fold an iterable of parts (strings / Uint8Arrays / Blobs) into one Blob, a batch
// at a time. Each batch becomes a Blob that the next one references rather than
// copies, so the JS side only ever holds one batch: a 3 GB ASCII PLY never has 3 GB
// of strings on the heap, and the browser keeps the bytes in blob storage (which it
// may page to disk). Byte-identical to `new Blob([...parts])`.
export function partsToBlob(parts, type = '', { batchBytes = 64 * 1024 * 1024 } = {}) {
  let blob = null,
    batch = [],
    size = 0
  for (const p of parts) {
    batch.push(p)
    size += typeof p === 'string' ? p.length : (p.byteLength ?? p.size ?? 0)
    if (size >= batchBytes) {
      blob = new Blob(blob ? [blob, ...batch] : batch, { type })
      batch = []
      size = 0
    }
  }
  return new Blob(blob ? [blob, ...batch] : batch, { type })
}

// Read a Blob/File as bounded Uint8Array chunks from `start` (slice + arrayBuffer
// per chunk — supported everywhere, unlike ReadableStream async iteration).
export async function* blobChunks(blob, { start = 0, end = blob.size, chunkBytes = 8 * 1024 * 1024 } = {}) {
  for (let off = start; off < end; off += chunkBytes) {
    yield new Uint8Array(await blob.slice(off, Math.min(end, off + chunkBytes)).arrayBuffer())
  }
}

// The injected-I/O shape core/io/cloudImport.js `parseCloudSource` reads.
export function blobSource(blob, name = blob.name ?? '') {
  return {
    name,
    size: blob.size,
    read: async (start, end) => new Uint8Array(await blob.slice(start, end).arrayBuffer()),
    chunks: (start = 0, chunkBytes) => blobChunks(blob, { start, ...(chunkBytes ? { chunkBytes } : {}) }),
  }
}

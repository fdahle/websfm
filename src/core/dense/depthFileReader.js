import { deserializeDepthMap } from './depthMapCodec.js'

// File/Blob handles are structured-cloned without materializing their bytes.
// Each call owns one map; callers release it before requesting its replacement.
export async function readDepthFiles(entry) {
  const buffers = {}
  for (const [key, file] of Object.entries(entry.files)) buffers[key] = file ? await file.arrayBuffer() : null
  const map = deserializeDepthMap(entry, buffers)
  if (!map) throw new Error(`Corrupt depth map ${entry.uuid}; recompute depth maps`)
  return { ...map, name: entry.name }
}

import { deserializeDepthMap, planeBytes } from './depthMapCodec.js'

// File/Blob handles are structured-cloned without materializing their bytes.
// Each call owns one map; callers release it before requesting its replacement.
export async function readDepthFiles(entry) {
  const buffers = {}
  for (const [key, file] of Object.entries(entry.files)) buffers[key] = file ? await file.arrayBuffer() : null
  const map = deserializeDepthMap(entry, buffers)
  if (!map) throw new Error(`Corrupt depth map ${entry.uuid}; recompute depth maps`)
  return { ...map, name: entry.name }
}

// A comparison view in streamed fusion's consistency check reads only its depth
// plane and camera. Every reference map is checked against every other map, so
// the comparison reads are N² — loading the cost/rgb/normal sidecars too (23 B/px
// instead of 4) made them ~6× the I/O and allocation for data nobody reads.
export async function readDepthOnly(entry) {
  const file = entry.files?.depth
  const buffer = file ? await file.arrayBuffer() : null
  if (!buffer || !(entry.width > 0) || !(entry.height > 0)
    || buffer.byteLength !== planeBytes(entry.width, entry.height).depth) {
    throw new Error(`Corrupt depth map ${entry.uuid}; recompute depth maps`)
  }
  return { uuid: entry.uuid, name: entry.name, width: entry.width, height: entry.height,
    K: entry.K, R: entry.R, t: entry.t, depth: new Float32Array(buffer) }
}

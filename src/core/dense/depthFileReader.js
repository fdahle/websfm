import { deserializeDepthMap, planeBytes } from './depthMapCodec.js'

// File/Blob handles are structured-cloned without materializing their bytes.
// Each call owns one map; callers release it before requesting its replacement.
// `normals: false` leaves the normal plane unread (12 of a map's 23 B/px): the
// orthophoto never uses it.
export async function readDepthFiles(entry, { normals = true } = {}) {
  const buffers = {}
  for (const [key, file] of Object.entries(entry.files)) {
    buffers[key] = file && (normals || key !== 'nrm') ? await file.arrayBuffer() : null
  }
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
  if (
    !buffer ||
    !(entry.width > 0) ||
    !(entry.height > 0) ||
    buffer.byteLength !== planeBytes(entry.width, entry.height).depth
  ) {
    throw new Error(`Corrupt depth map ${entry.uuid}; recompute depth maps`)
  }
  return {
    uuid: entry.uuid,
    name: entry.name,
    width: entry.width,
    height: entry.height,
    K: entry.K,
    R: entry.R,
    t: entry.t,
    depth: new Float32Array(buffer),
  }
}

// A reference map in the streamed cross-view filter needs its depth and cost — never
// its rgb or normals.
export async function readDepthAndCost(entry) {
  const want = planeBytes(entry.width, entry.height)
  const read = async (key) => {
    const buffer = entry.files?.[key] ? await entry.files[key].arrayBuffer() : null
    if (!buffer || buffer.byteLength !== want[key])
      throw new Error(`Corrupt depth map ${entry.uuid}; recompute depth maps`)
    return new Float32Array(buffer)
  }
  return { depth: await read('depth'), cost: await read('cost') }
}

// A map for fusion's pre-passes (core/dense/fusionPlan.js `{ light }` requests): its
// camera, depth and cost, never its rgb or normals (2/3 of its bytes).
export async function readDepthCostMap(entry) {
  const { depth, cost } = await readDepthAndCost(entry)
  return {
    uuid: entry.uuid,
    name: entry.name,
    width: entry.width,
    height: entry.height,
    K: entry.K,
    R: entry.R,
    t: entry.t,
    depth,
    cost,
  }
}

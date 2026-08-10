// Pure COLMAP SQLite row/blob adapters. SQLite itself lives in a dedicated
// worker; this module owns the on-disk conventions so they remain unit-testable.

export const COLMAP_MAX_IMAGE_ID = 2147483647

// Current COLMAP camera model ids (sensor/models.h). `names` is the parameter
// order in the database's float64 blob.
export const COLMAP_CAMERA_MODELS = {
  0:  { model: 'SIMPLE_PINHOLE', names: ['f', 'cx', 'cy'] },
  1:  { model: 'PINHOLE', names: ['fx', 'fy', 'cx', 'cy'] },
  2:  { model: 'SIMPLE_RADIAL', names: ['f', 'cx', 'cy', 'k1'] },
  3:  { model: 'RADIAL', names: ['f', 'cx', 'cy', 'k1', 'k2'] },
  4:  { model: 'OPENCV', names: ['fx', 'fy', 'cx', 'cy', 'k1', 'k2', 'p1', 'p2'] },
  5:  { model: 'OPENCV_FISHEYE', names: ['fx', 'fy', 'cx', 'cy', 'k1', 'k2', 'k3', 'k4'] },
  6:  { model: 'FULL_OPENCV', names: ['fx', 'fy', 'cx', 'cy', 'k1', 'k2', 'p1', 'p2', 'k3', 'k4', 'k5', 'k6'] },
  7:  { model: 'FOV', names: ['fx', 'fy', 'cx', 'cy', 'omega'] },
  8:  { model: 'SIMPLE_RADIAL_FISHEYE', names: ['f', 'cx', 'cy', 'k1'] },
  9:  { model: 'RADIAL_FISHEYE', names: ['f', 'cx', 'cy', 'k1', 'k2'] },
  10: { model: 'THIN_PRISM_FISHEYE', names: ['fx', 'fy', 'cx', 'cy', 'k1', 'k2', 'p1', 'p2', 'k3', 'k4', 'sx1', 'sy1'] },
  11: { model: 'RAD_TAN_THIN_PRISM_FISHEYE', names: ['fx', 'fy', 'cx', 'cy', 'k0', 'k1', 'k2', 'k3', 'p0', 'p1', 'sx0', 'sy0'] },
}

export function imageIdsToPairId(imageId1, imageId2) {
  const a = Number(imageId1), b = Number(imageId2)
  if (!Number.isInteger(a) || !Number.isInteger(b) || a <= 0 || b <= 0 || a >= COLMAP_MAX_IMAGE_ID || b >= COLMAP_MAX_IMAGE_ID || a === b)
    throw new Error('COLMAP pair ids require two distinct positive 31-bit image ids')
  const lo = Math.min(a, b), hi = Math.max(a, b)
  const pair = BigInt(COLMAP_MAX_IMAGE_ID) * BigInt(lo) + BigInt(hi)
  return pair <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(pair) : pair
}

export function pairIdToImageIds(pairId) {
  let pair
  try { pair = typeof pairId === 'bigint' ? pairId : BigInt(pairId) } catch { throw new Error('Invalid COLMAP pair_id') }
  if (pair <= 0n) throw new Error('Invalid COLMAP pair_id')
  const max = BigInt(COLMAP_MAX_IMAGE_ID), imageId2 = pair % max, imageId1 = (pair - imageId2) / max
  if (imageId1 <= 0n || imageId2 <= 0n || imageId1 >= imageId2 || imageId2 >= max)
    throw new Error('Invalid COLMAP pair_id')
  return [Number(imageId1), Number(imageId2)]
}

function bytesOf(blob) {
  if (blob instanceof Uint8Array) return blob
  if (blob instanceof ArrayBuffer) return new Uint8Array(blob)
  if (ArrayBuffer.isView(blob)) return new Uint8Array(blob.buffer, blob.byteOffset, blob.byteLength)
  throw new Error('Expected a SQLite blob')
}

function typedBlob(blob, Type, count, label) {
  const bytes = bytesOf(blob)
  const expected = count * Type.BYTES_PER_ELEMENT
  if (bytes.byteLength !== expected) throw new Error(`${label}: expected ${expected} bytes, got ${bytes.byteLength}`)
  // SQLite's returned view may be unaligned. Copy before constructing f32/f64/u32.
  const copy = bytes.slice()
  return new Type(copy.buffer)
}

export function decodeColmapCamera(row) {
  const spec = COLMAP_CAMERA_MODELS[Number(row.model)]
  if (!spec) return { cameraId: Number(row.camera_id), modelId: Number(row.model), model: `UNKNOWN_${row.model}`, width: Number(row.width), height: Number(row.height), params: [], named: {}, supported: false, losses: ['unsupported camera model'] }
  const params = [...typedBlob(row.params, Float64Array, spec.names.length, `camera ${row.camera_id} params`)]
  const named = Object.fromEntries(spec.names.map((name, i) => [name, params[i]]))
  const fisheye = spec.model.includes('FISHEYE') || spec.model === 'FOV'
  return {
    cameraId: Number(row.camera_id), modelId: Number(row.model), model: spec.model,
    width: Number(row.width), height: Number(row.height), params, named,
    // websfm can preserve Brown/radial calibration, but its sparse ingest remains
    // pinhole. Fisheye models need a resampling stage and are reported, not guessed.
    supported: !fisheye,
    losses: fisheye ? ['fisheye projection cannot be mapped without resampling'] : [],
  }
}

export function cameraToWebsfmSensor(camera) {
  if (!camera?.supported) return null
  const p = camera.named
  return {
    externalId: camera.cameraId,
    label: `COLMAP Camera ${camera.cameraId}`,
    width: camera.width, height: camera.height,
    focal: p.fx ?? p.f ?? null, focalUnit: 'px',
    fx: p.fx ?? p.f ?? null, fy: p.fy ?? p.f ?? null,
    cx: p.cx ?? null, cy: p.cy ?? null,
    k1: p.k1 ?? p.k ?? null, k2: p.k2 ?? null, k3: p.k3 ?? null,
    p1: p.p0 ?? p.p1 ?? null, p2: p.p0 != null ? (p.p1 ?? null) : (p.p2 ?? null),
    distortionModel: (p.p1 != null || p.p0 != null) ? 'brown' : p.k2 != null ? 'radial2' : p.k1 != null ? 'radial' : 'pinhole',
    source: 'colmap',
  }
}

export function decodeColmapKeypoints(row) {
  const rows = Number(row.rows), cols = Number(row.cols)
  if (![2, 4, 6].includes(cols)) throw new Error(`image ${row.image_id} keypoints: unsupported ${cols}-column layout`)
  const values = typedBlob(row.data, Float32Array, rows * cols, `image ${row.image_id} keypoints`)
  const keypoints = new Array(rows)
  for (let i = 0; i < rows; i++) {
    const o = i * cols
    keypoints[i] = {
      x: values[o], y: values[o + 1],
      scale: cols === 4 ? values[o + 2] : 1,
      orientation: cols === 4 ? values[o + 3] : null,
      affine: cols === 6 ? [values[o + 2], values[o + 3], values[o + 4], values[o + 5]] : null,
      response: 0,
    }
  }
  return keypoints
}

export function decodeColmapDescriptors(row) {
  const rows = Number(row.rows), bytesPerRow = Number(row.cols)
  const bytes = bytesOf(row.data)
  if (bytes.byteLength !== rows * bytesPerRow) throw new Error(`image ${row.image_id} descriptors: invalid blob length`)
  if (bytesPerRow === 128) {
    const out = new Float32Array(rows * 128)
    // COLMAP's SIFT descriptors are RootSIFT-like values quantized by ×512.
    // The common scalar is immaterial to Lowe ratios but restoring it keeps norms sane.
    for (let i = 0; i < out.length; i++) out[i] = bytes[i] / 512
    return { descriptors: out, descriptorType: 'sift-u8', descDim: 128, compatible: true }
  }
  if (bytesPerRow === 512) {
    const raw = typedBlob(bytes, Float32Array, rows * 128, `image ${row.image_id} ALIKED descriptors`)
    return { descriptors: raw.slice(), descriptorType: 'aliked-f32', descDim: 128, compatible: true }
  }
  return { descriptors: null, descriptorType: `unknown-${bytesPerRow}-bytes`, descDim: null, compatible: false }
}

export function decodeColmapMatches(row) {
  const rows = Number(row.rows), cols = Number(row.cols)
  if (cols !== 2) throw new Error(`pair ${row.pair_id}: matches must have two columns`)
  const raw = typedBlob(row.data, Uint32Array, rows * 2, `pair ${row.pair_id} matches`)
  const matches = new Array(rows)
  for (let i = 0; i < rows; i++) matches[i] = [raw[i * 2], raw[i * 2 + 1]]
  return matches
}

export function decodeColmapMatrix(blob, label = 'matrix') {
  if (blob == null) return null
  const a = typedBlob(blob, Float64Array, 9, label)
  return [[a[0], a[1], a[2]], [a[3], a[4], a[5]], [a[6], a[7], a[8]]]
}

export function buildColmapDatabaseManifest(summary, sourceName = 'database.db') {
  const warnings = []
  if (summary.unsupportedCameras) warnings.push(`${summary.unsupportedCameras} unsupported camera model(s)`)
  if (summary.rigs || summary.frames) warnings.push('Camera rigs/frames are inspected but websfm does not yet preserve rig constraints')
  return {
    format: 'colmap-database', version: summary.userVersion || null, sourceName,
    images: summary.images || [], cameras: summary.cameras || [],
    features: summary.features || [], pairs: summary.pairs || [], models: [],
    rigs: summary.rigs || 0, frames: summary.frames || 0, posePriors: summary.posePriors || 0,
    warnings, estimatedBytes: summary.bytes || 0,
  }
}

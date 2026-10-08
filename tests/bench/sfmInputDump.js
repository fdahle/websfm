// SfM worker-input dump: the exact `reconstruct` payload a bench run sends to the
// worker, saved so node can replay it (src/core/sfm/sfmGolden.test.js, real-data
// scenes). Used by the bench page (encode) and the node tests (decode); no app code
// imports it.
//
// Layout: 'WSFMIN01' · u32 header length · header JSON · binary section. Bulk arrays
// (keypoint positions and colours, descriptors, match indices) are stored as raw
// little-endian typed arrays; everything else (meta, sensors, F, GCPs, priors,
// settings) lives in the JSON header.

const MAGIC = 'WSFMIN01'

function keypointArrays(kps) {
  // Object keypoints [{x, y, color?}] or an already-compact { n, xy, rgb, hasColor }.
  if (kps && !Array.isArray(kps) && kps.xy) {
    return { n: kps.n, xy: kps.xy, rgb: kps.rgb ?? new Uint8Array(3 * kps.n), mask: kps.hasColor ?? new Uint8Array(kps.n) }
  }
  const n = kps?.length ?? 0
  const xy = new Float64Array(2 * n), rgb = new Uint8Array(3 * n), mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const k = kps[i]
    xy[2 * i] = k.x; xy[2 * i + 1] = k.y
    if (k.color) { rgb[3 * i] = k.color[0]; rgb[3 * i + 1] = k.color[1]; rgb[3 * i + 2] = k.color[2]; mask[i] = 1 }
  }
  return { n, xy, rgb, mask }
}

const matchData = (m) => (m instanceof Uint32Array ? m : m?.data instanceof Uint32Array ? m.data
  : Uint32Array.from((m ?? []).flat()))

/** @returns {Uint8Array} */
export function encodeSfmInput(input) {
  const chunks = []
  let offset = 0
  const put = (typed) => {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)
    const pad = (8 - (offset % 8)) % 8
    if (pad) { chunks.push(new Uint8Array(pad)); offset += pad }
    const ref = { offset, length: typed.length }
    chunks.push(bytes.slice())
    offset += bytes.byteLength
    return ref
  }
  const images = (input.images ?? []).map((img) => {
    const { keypoints, descU8, ...rest } = img
    const k = keypointArrays(keypoints)
    return {
      ...rest,
      kp: { n: k.n, xy: put(k.xy), rgb: put(k.rgb), mask: put(k.mask) },
      descU8: descU8 ? put(descU8) : null,
    }
  })
  const pairs = (input.pairs ?? []).map((p) => {
    const { matches, ...rest } = p
    return { ...rest, matches: put(matchData(matches)) }
  })
  const header = {
    version: 1, images, pairs,
    gcps: input.gcps ?? [], cameraPriors: input.cameraPriors ?? [], settings: input.settings ?? {},
  }
  const json = new TextEncoder().encode(JSON.stringify(header))
  const pre = new Uint8Array(8 + 4 + json.length)
  pre.set(new TextEncoder().encode(MAGIC), 0)
  new DataView(pre.buffer).setUint32(8, json.length, true)
  pre.set(json, 12)
  // The binary section starts 8-byte aligned after the header.
  const lead = (8 - (pre.length % 8)) % 8
  const out = new Uint8Array(pre.length + lead + offset)
  out.set(pre, 0)
  let at = pre.length + lead
  for (const c of chunks) { out.set(c, at); at += c.byteLength }
  return out
}

/**
 * The payload as the worker receives it: object keypoints, uint8 descriptors and
 * packed matches (a Uint32Array per pair; the caller wraps them like the worker op).
 */
export function decodeSfmInput(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  if (new TextDecoder().decode(u8.subarray(0, 8)) !== MAGIC) throw new Error('not an SfM input dump')
  const len = new DataView(u8.buffer, u8.byteOffset, u8.byteLength).getUint32(8, true)
  const header = JSON.parse(new TextDecoder().decode(u8.subarray(12, 12 + len)))
  const base = 12 + len + ((8 - ((12 + len) % 8)) % 8)
  const buf = u8.buffer.slice(u8.byteOffset + base, u8.byteOffset + u8.byteLength)
  const view = (Type, ref) => new Type(buf.slice(ref.offset, ref.offset + ref.length * Type.BYTES_PER_ELEMENT))
  const images = header.images.map(({ kp, descU8, ...rest }) => {
    const xy = view(Float64Array, kp.xy), rgb = view(Uint8Array, kp.rgb), mask = view(Uint8Array, kp.mask)
    const keypoints = new Array(kp.n)
    for (let i = 0; i < kp.n; i++) {
      keypoints[i] = { x: xy[2 * i], y: xy[2 * i + 1], color: mask[i] ? [rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]] : undefined }
    }
    return { ...rest, keypoints, ...(descU8 ? { descU8: view(Uint8Array, descU8) } : {}) }
  })
  const pairs = header.pairs.map(({ matches, ...rest }) => ({ ...rest, matches: view(Uint32Array, matches) }))
  return { images, pairs, gcps: header.gcps, cameraPriors: header.cameraPriors, settings: header.settings }
}

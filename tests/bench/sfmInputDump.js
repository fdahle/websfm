// SfM worker-input dump: the exact `reconstruct` payload a bench run sends to the
// worker, saved so node can replay it (src/core/sfm/sfmGolden.test.js, real-data
// scenes). Used by the bench page (encode) and the node tests (decode); no app code
// imports it.
//
// Layout: 'WSFMIN01' · u32 header length · header JSON · binary section. Bulk arrays
// (keypoint positions, scales and colours, descriptors, match indices) are stored as raw
// little-endian typed arrays; everything else (meta, sensors, F, GCPs, priors,
// settings) lives in the JSON header.

const MAGIC = 'WSFMIN01'

function keypointArrays(kps) {
  // Object keypoints [{x, y, scale?, color?}], the store's typed { data } (KP_STRIDE 6:
  // x, y, nx, ny, scale, response) or an already-compact { n, xy, scale?, rgb, hasColor }.
  // A dump written before the scale was carried has none: its keypoints read as scale 0.
  if (kps && !Array.isArray(kps) && kps.xy) {
    return {
      n: kps.n,
      xy: kps.xy,
      scale: kps.scale ?? null,
      rgb: kps.rgb ?? new Uint8Array(3 * kps.n),
      mask: kps.hasColor ?? new Uint8Array(kps.n),
    }
  }
  if (kps?.data instanceof Float32Array) {
    const n = Math.floor(kps.data.length / 6)
    const xy = new Float64Array(2 * n),
      scale = new Float32Array(n)
    for (let i = 0; i < n; i++) {
      xy[2 * i] = kps.data[6 * i]
      xy[2 * i + 1] = kps.data[6 * i + 1]
      scale[i] = kps.data[6 * i + 4]
    }
    const colored = kps.rgb?.length === 3 * n
    return {
      n,
      xy,
      scale,
      rgb: colored ? kps.rgb : new Uint8Array(3 * n),
      mask: colored ? new Uint8Array(n).fill(1) : new Uint8Array(n),
    }
  }
  const n = kps?.length ?? 0
  const xy = new Float64Array(2 * n),
    scale = new Float32Array(n),
    rgb = new Uint8Array(3 * n),
    mask = new Uint8Array(n)
  for (let i = 0; i < n; i++) {
    const k = kps[i]
    xy[2 * i] = k.x
    xy[2 * i + 1] = k.y
    scale[i] = k.scale ?? 0
    if (k.color) {
      rgb[3 * i] = k.color[0]
      rgb[3 * i + 1] = k.color[1]
      rgb[3 * i + 2] = k.color[2]
      mask[i] = 1
    }
  }
  return { n, xy, scale, rgb, mask }
}

const matchData = (m) =>
  m instanceof Uint32Array ? m : m?.data instanceof Uint32Array ? m.data : Uint32Array.from((m ?? []).flat())

/** @returns {Uint8Array} */
export function encodeSfmInput(input) {
  const parts = encodeSfmInputParts(input)
  const out = new Uint8Array(parts.reduce((n, p) => n + p.byteLength, 0))
  let at = 0
  for (const p of parts) {
    out.set(p, at)
    at += p.byteLength
  }
  return out
}

/**
 * The same bytes as encodeSfmInput, as a list of parts (header first). A large input
 * (PUTI at 5,000 px: 2.3 GB) fits no single ArrayBuffer a Blob accepts, nor twice in the
 * page heap; the bench page passes the parts straight to a Blob. `copy: false` keeps
 * views of the input's own arrays (valid only until they are transferred).
 * @returns {Uint8Array[]}
 */
export function encodeSfmInputParts(input, { copy = true } = {}) {
  const chunks = []
  let offset = 0
  const put = (typed) => {
    const bytes = new Uint8Array(typed.buffer, typed.byteOffset, typed.byteLength)
    const pad = (8 - (offset % 8)) % 8
    if (pad) {
      chunks.push(new Uint8Array(pad))
      offset += pad
    }
    const ref = { offset, length: typed.length }
    chunks.push(copy ? bytes.slice() : bytes)
    offset += bytes.byteLength
    return ref
  }
  const images = (input.images ?? []).map((img) => {
    const { keypoints, descU8, ...rest } = img
    const k = keypointArrays(keypoints)
    return {
      ...rest,
      kp: { n: k.n, xy: put(k.xy), ...(k.scale ? { scale: put(k.scale) } : {}), rgb: put(k.rgb), mask: put(k.mask) },
      descU8: descU8 ? put(descU8) : null,
    }
  })
  const pairs = (input.pairs ?? []).map((p) => {
    const { matches, ...rest } = p
    return { ...rest, matches: put(matchData(matches)) }
  })
  const header = {
    version: 1,
    images,
    pairs,
    gcps: input.gcps ?? [],
    cameraPriors: input.cameraPriors ?? [],
    settings: input.settings ?? {},
  }
  const json = new TextEncoder().encode(JSON.stringify(header))
  const pre = new Uint8Array(8 + 4 + json.length)
  pre.set(new TextEncoder().encode(MAGIC), 0)
  new DataView(pre.buffer).setUint32(8, json.length, true)
  pre.set(json, 12)
  // The binary section starts 8-byte aligned after the header.
  const lead = (8 - (pre.length % 8)) % 8
  return [pre, new Uint8Array(lead), ...chunks]
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
    const xy = view(Float64Array, kp.xy),
      scale = kp.scale ? view(Float32Array, kp.scale) : null,
      rgb = view(Uint8Array, kp.rgb),
      mask = view(Uint8Array, kp.mask)
    const keypoints = new Array(kp.n)
    for (let i = 0; i < kp.n; i++) {
      keypoints[i] = {
        x: xy[2 * i],
        y: xy[2 * i + 1],
        ...(scale ? { scale: scale[i] } : {}),
        color: mask[i] ? [rgb[3 * i], rgb[3 * i + 1], rgb[3 * i + 2]] : undefined,
      }
    }
    return { ...rest, keypoints, ...(descU8 ? { descU8: view(Uint8Array, descU8) } : {}) }
  })
  const pairs = header.pairs.map(({ matches, ...rest }) => ({ ...rest, matches: view(Uint32Array, matches) }))
  return { images, pairs, gcps: header.gcps, cameraPriors: header.cameraPriors, settings: header.settings }
}

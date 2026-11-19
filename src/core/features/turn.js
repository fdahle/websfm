// Photos turned by a quarter turn before a learned detector reads them (pure).
//
// SuperPoint, DISK and ALIKED with LightGlue hold about ±15° of rotation. Flights in
// opposite directions turn their photos ~180° against each other: Rachel's TMA block
// (headings 115° against 290°) matched as two pieces that never joined, while SIFT
// found 196 pairs between them. A photo detected turned keeps its keypoints in its own
// pixels — only the descriptors come from the turned raster — so tracks, geometry and
// every stored coordinate are unchanged; LightGlue is fed the keypoints in the turned
// frame (lightglue.js), as the descriptors saw them.
//
// `turn` is clockwise degrees, one of 0, 90, 180, 270. Pixel centres sit on integers.

export const TURNS = [0, 90, 180, 270]

// Any angle (degrees, clockwise) → the nearest quarter turn.
export function nearestTurn(deg) {
  if (!Number.isFinite(deg)) return 0
  return ((Math.round(deg / 90) % 4) * 90 + 360) % 360
}

// The unturned pixel (width × height, the original's size) a turned pixel shows.
export function unturnPoint(x, y, width, height, turn) {
  switch (turn) {
    case 90:
      return [y, height - 1 - x]
    case 180:
      return [width - 1 - x, height - 1 - y]
    case 270:
      return [width - 1 - y, x]
    default:
      return [x, y]
  }
}

// A raster (`channels` interleaved values per pixel) turned clockwise by `turn`.
// 180° turns `data` in place (a 10,000 px scan is 400 MB of RGBA: no second copy);
// 90° and 270° return a new array. → { data, width, height } (the turned size).
export function turnRaster(data, width, height, turn, channels = 4) {
  if (!turn) return { data, width, height }
  if (turn === 180) {
    const n = width * height
    for (let i = 0, j = n - 1; i < j; i++, j--) {
      for (let c = 0; c < channels; c++) {
        const a = i * channels + c,
          b = j * channels + c
        const t = data[a]
        data[a] = data[b]
        data[b] = t
      }
    }
    return { data, width, height }
  }
  const tw = height,
    th = width
  const out = new data.constructor(data.length)
  for (let y = 0; y < th; y++)
    for (let x = 0; x < tw; x++) {
      const [ux, uy] = unturnPoint(x, y, width, height, turn)
      const o = (y * tw + x) * channels,
        s = (uy * width + ux) * channels
      for (let c = 0; c < channels; c++) out[o + c] = data[s + c]
    }
  return { data: out, width: tw, height: th }
}

// Centred coordinates (u, v) of a point in the unturned image → the same point's
// centred coordinates in the turned image. A turn about the centre is a rotation of
// the vector: 90° clockwise takes (u, v) to (−v, u) with y pointing down.
export function turnCentred(u, v, turn) {
  switch (turn) {
    case 90:
      return [-v, u]
    case 180:
      return [-u, -v]
    case 270:
      return [v, -u]
    default:
      return [u, v]
  }
}

// A position in the unturned image (continuous pixels: the image spans 0…width and
// 0…height, edges, not pixel centres) → the same position in the image turned clockwise
// by `turn`, whose size is height × width at 90° and 270°. What a viewer that shows a
// photo turned draws its points with.
export function turnPosition(x, y, width, height, turn) {
  switch (turn) {
    case 90:
      return [height - y, x]
    case 180:
      return [width - x, height - y]
    case 270:
      return [y, width - x]
    default:
      return [x, y]
  }
}

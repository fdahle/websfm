import { fromBlob } from 'geotiff'

// Window reads of a stored raster file (a computed orthophoto's COG) inside a worker:
// the clip and the exports read only the rows/window they need, through geotiff.js's
// Blob range reads, never the whole file.

// The full-resolution image (IFD 0).
export async function openRaster(file) {
  return (await fromBlob(file)).getImage(0)
}

// Cells [x0, x1) × [y0, y1) at full resolution, samples interleaved, as bytes.
export async function readWindowBytes(image, x0, y0, x1, y1) {
  const raw = await image.readRasters({ window: [x0, y0, x1, y1], interleave: true })
  return new Uint8Array(raw.buffer, raw.byteOffset, raw.byteLength)
}

// A band of whole rows at a time, sized to about `bandBytes` — the streamed exports' unit.
export function rowsPerBand(width, bytesPerPixel, bandBytes = 8 << 20) {
  return Math.max(1, Math.floor(bandBytes / (width * bytesPerPixel)))
}

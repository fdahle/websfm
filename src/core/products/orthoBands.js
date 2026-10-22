// An orthophoto exported without its alpha band (Export Orthophoto, Alpha band off;
// JPEG always): the uncovered pixels (alpha 0) take the NODATA value in every band.
// GDAL reads NODATA per band, so a covered pixel whose red, green or blue happens to
// equal it would read as a hole in that band: such a value moves one level toward
// the middle, which no eye sees.

// The NODATA value as a byte (0–255), whatever was typed.
export function orthoNodataByte(value) {
  const v = Math.round(Number(value))
  return Number.isFinite(v) ? Math.min(255, Math.max(0, v)) : 0
}

const nudge = (nodata) => (nodata < 128 ? nodata + 1 : nodata - 1)

// RGBA rows → RGB rows (a 3-band GeoTIFF strip).
export function rgbaToRgb(rgba, nodata) {
  const n = rgba.length >> 2
  const out = new Uint8Array(n * 3)
  const moved = nudge(nodata)
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
    if (rgba[j + 3] === 0) {
      out[k] = out[k + 1] = out[k + 2] = nodata
      continue
    }
    for (let b = 0; b < 3; b++) {
      const v = rgba[j + b]
      out[k + b] = v === nodata ? moved : v
    }
  }
  return out
}

// The same in place on RGBA (an opaque PNG or a JPEG through a canvas).
export function fillUncovered(rgba, nodata) {
  const moved = nudge(nodata)
  for (let j = 0; j < rgba.length; j += 4) {
    if (rgba[j + 3] === 0) {
      rgba[j] = rgba[j + 1] = rgba[j + 2] = nodata
    } else {
      for (let b = 0; b < 3; b++) if (rgba[j + b] === nodata) rgba[j + b] = moved
    }
    rgba[j + 3] = 255
  }
  return rgba
}

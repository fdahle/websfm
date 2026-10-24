// Worker-side canvas helpers: RGBA bytes → a PNG Blob (computed DEM/ortho previews,
// which can be 4096² and must stay off the V8 heap) or a PNG data URL (the ≤1024 px
// imported reference-raster previews).
//
// Not in core/ — OffscreenCanvas is a DOM/worker API, and core/*.js is pure. The
// pixel *math* (elevation ramp + hillshade) lives in core/products/colormap.js;
// this is only the encode, shared by the products ops (computed DEM/ortho
// previews) and the io ops (imported reference-raster previews).
export async function rasterToPng(rgba, w, h) {
  const canvas = new OffscreenCanvas(w, h)
  canvas
    .getContext('2d', { willReadFrequently: true })
    .putImageData(rgba instanceof ImageData ? rgba : new ImageData(rgba, w, h), 0, 0)
  return canvas.convertToBlob({ type: 'image/png' })
}

export async function rasterToDataUrl(rgba, w, h) {
  const blob = await rasterToPng(rgba, w, h)
  return await new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.readAsDataURL(blob)
  })
}

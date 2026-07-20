// Worker-side canvas helper: RGBA bytes → a PNG data URL.
//
// Not in core/ — OffscreenCanvas is a DOM/worker API, and core/*.js is pure. The
// pixel *math* (elevation ramp + hillshade) lives in core/products/colormap.js;
// this is only the encode, shared by the products ops (computed DEM/ortho
// previews) and the io ops (imported reference-raster previews).
export async function rasterToDataUrl(rgba, w, h) {
  const canvas = new OffscreenCanvas(w, h)
  canvas.getContext('2d').putImageData(
    rgba instanceof ImageData ? rgba : new ImageData(rgba, w, h), 0, 0)
  const blob = await canvas.convertToBlob({ type: 'image/png' })
  return await new Promise((resolve) => {
    const fr = new FileReader()
    fr.onload = () => resolve(fr.result)
    fr.readAsDataURL(blob)
  })
}

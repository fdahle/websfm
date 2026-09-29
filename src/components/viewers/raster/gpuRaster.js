import GeoTIFF from 'ol/source/GeoTIFF.js'
import WebGLTile from 'ol/layer/WebGLTile.js'
import { gpuRasterStyle } from '../../../core/io/rasterGpuStyle.js'
export { gpuRasterStyle }

export async function createGpuRasterLayer(meta, file) {
  const source = new GeoTIFF({ sources: [{ blob: file }], normalize: false, interpolate: false,
    projection: meta.crs || undefined, convertToRGB: 'auto' })
  try {
    await source.getView()
    const layer = new WebGLTile({ source, style: gpuRasterStyle(meta), opacity: meta.opacity ?? 1, cacheSize: 64 })
    layer.set('gpuRaster', true)
    return layer
  } catch (err) { source.dispose(); throw err }
}
export function disposeRasterLayer(layer) { layer?.getSource()?.dispose(); layer?.dispose() }

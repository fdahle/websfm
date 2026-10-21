// Symbology of the computed DEM / orthophoto (Products ▸ right-click ▸ Symbology…).
// Pure: the modal, the products worker and the viewers all read the same resolved
// style, so the sidebar preview, the tab and the map can never disagree.
//
// Display only. The DEM's heights and the ortho's COG are never touched: exports,
// tools and the cursor readout keep reading the original values.
//
//   DEM:   { ramp, range: 'auto' | 'manual', min, max, hillshade } — baked into the
//          preview PNG (hillshadeRgba), which the tab and the map draw.
//   ortho: { brightness, contrast, gamma } — applied at draw time: OpenLayers'
//          WebGLTile adjustments on the tiled COG, and the same maths as an SVG
//          filter on the preview image (orthoAdjustFilter), so both match.

import { RAMPS } from './colormap.js'

// Ramp keys are persisted with the DEM, like a raster style's (colormap.js RAMPS).
export const DEM_RAMPS = [
  { value: 'turbo', label: 'Blue → red' },
  { value: 'viridis', label: 'Viridis' },
  { value: 'gray', label: 'Greyscale' },
  { value: 'rdylgn', label: 'Red → green' },
  { value: 'rdbu', label: 'Blue → white → red' },
]

// The unstyled preview: the turbo ramp over the DEM's own range, hillshaded.
export const DEFAULT_DEM_STYLE = Object.freeze({ ramp: 'turbo', range: 'auto', min: null, max: null, hillshade: true })
export const DEFAULT_ORTHO_STYLE = Object.freeze({ brightness: 0, contrast: 0, gamma: 1 })

const num = (v) => (v == null || v === '' ? NaN : Number(v))
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

// A stored (or hand-edited) style → every field present and valid. A manual range
// that is not increasing falls back to the DEM's own range rather than painting
// one flat colour.
export function resolveDemStyle(style) {
  const s = style && typeof style === 'object' ? style : {}
  const min = num(s.min),
    max = num(s.max)
  const manual = s.range === 'manual' && Number.isFinite(min) && Number.isFinite(max) && max > min
  return {
    ramp: RAMPS[s.ramp] ? s.ramp : DEFAULT_DEM_STYLE.ramp,
    range: manual ? 'manual' : 'auto',
    min: manual ? min : null,
    max: manual ? max : null,
    hillshade: s.hillshade !== false,
  }
}

// The heights the ramp spans: the manual limits, or the DEM's own z range.
export function demStyleRange(style, dem) {
  const s = resolveDemStyle(style)
  return s.range === 'manual' ? [s.min, s.max] : [dem?.zMin, dem?.zMax]
}

// The options hillshadeRgba takes for this style over this DEM.
export function demRenderOptions(style, dem) {
  const s = resolveDemStyle(style)
  const [min, max] = demStyleRange(s, dem)
  return { ramp: s.ramp, min, max, hillshade: s.hillshade }
}

export function resolveOrthoStyle(style) {
  const s = style && typeof style === 'object' ? style : {}
  const brightness = num(s.brightness),
    contrast = num(s.contrast),
    gamma = num(s.gamma)
  return {
    brightness: Number.isFinite(brightness) ? clamp(brightness, -1, 1) : 0,
    contrast: Number.isFinite(contrast) ? clamp(contrast, -1, 1) : 0,
    gamma: Number.isFinite(gamma) && gamma > 0 ? clamp(gamma, 0.1, 5) : 1,
  }
}

export function isDefaultOrthoStyle(style) {
  const s = resolveOrthoStyle(style)
  return s.brightness === 0 && s.contrast === 0 && s.gamma === 1
}

// The WebGLTile style entries for an ortho's adjustments (ol/layer/WebGLTile: its
// shader applies contrast, then gamma, then brightness). Only the non-neutral ones,
// so an unstyled ortho compiles the shader it always did.
export function orthoGpuAdjustments(style) {
  const s = resolveOrthoStyle(style),
    out = {}
  if (s.contrast) out.contrast = s.contrast
  if (s.gamma !== 1) out.gamma = s.gamma
  if (s.brightness) out.brightness = s.brightness
  return out
}

// One 8-bit channel value through the same pipeline as the shader (for tests and
// for anything that must bake the adjustment into pixels).
export function adjustChannel(v, style) {
  const s = resolveOrthoStyle(style)
  let x = v / 255
  x = clamp((s.contrast + 1) * x - s.contrast / 2, 0, 1)
  x = Math.pow(x, 1 / s.gamma)
  x = clamp(x + s.brightness, 0, 1)
  return Math.round(x * 255)
}

// The SVG <feComponentTransfer> functions for the same pipeline: a linear transfer
// (slope, intercept) per contrast and brightness step, a gamma transfer (exponent
// 1/gamma) between them. Each primitive clamps to 0…1, as the shader does.
export function orthoFilterSteps(style) {
  const s = resolveOrthoStyle(style),
    steps = []
  if (s.contrast) steps.push({ type: 'linear', slope: s.contrast + 1, intercept: -s.contrast / 2 })
  if (s.gamma !== 1) steps.push({ type: 'gamma', amplitude: 1, exponent: 1 / s.gamma, offset: 0 })
  if (s.brightness) steps.push({ type: 'linear', slope: 1, intercept: s.brightness })
  return steps
}

// A small copy of a DEM for the modal's live preview: nearest-cell sampled down to
// at most `maxDim` px on the long side, with the GSD scaled to match so the
// hillshade's relief reads the same as the full preview's.
export function demThumbnailGrid(dem, maxDim = 320) {
  if (!dem?.data || !dem.width || !dem.height) return null
  const step = Math.max(1, Math.max(dem.width, dem.height) / maxDim)
  const width = Math.max(1, Math.round(dem.width / step)),
    height = Math.max(1, Math.round(dem.height / step))
  const data = new Float32Array(width * height)
  const mask = dem.mask ? new Uint8Array(width * height) : null
  for (let r = 0; r < height; r++) {
    const sr = Math.min(dem.height - 1, Math.floor(((r + 0.5) * dem.height) / height))
    for (let c = 0; c < width; c++) {
      const sc = Math.min(dem.width - 1, Math.floor(((c + 0.5) * dem.width) / width))
      const i = sr * dem.width + sc
      data[r * width + c] = dem.data[i]
      if (mask) mask[r * width + c] = dem.mask[i]
    }
  }
  return { width, height, data, mask, gsd: dem.gsd * (dem.width / width), zMin: dem.zMin, zMax: dem.zMax }
}

const fmtZ = (v) => (Number.isFinite(v) ? Number(v.toPrecision(5)).toString() : '—')
export function describeDemStyle(style, dem) {
  const s = resolveDemStyle(style)
  const [lo, hi] = demStyleRange(s, dem)
  const ramp = DEM_RAMPS.find((r) => r.value === s.ramp)?.label ?? s.ramp
  return `${ramp}, ${s.range === 'manual' ? 'manual' : 'automatic'} ${fmtZ(lo)}–${fmtZ(hi)}${s.hillshade ? ', hillshaded' : ''}`
}

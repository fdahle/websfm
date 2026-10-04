import { resolveRasterStyle, bandsUsedBy } from './rasterStyle.js'
import { rampByName } from '../products/colormap.js'

// A stretch must have finite, increasing ends: a DEM with no recorded zMax (an
// all-nodata or never-scanned plane) or a constant band would otherwise compile a
// NaN or a division by zero into the shader expression and render nothing.
export function safeStretchRange(range, fallback = [0, 255]) {
  const lo = Number(range?.[0]), hi = Number(range?.[1])
  if (Number.isFinite(lo) && Number.isFinite(hi)) return hi > lo ? [lo, hi] : [lo, lo + 1]
  if (Number.isFinite(lo)) return [lo, lo + 1]
  if (Number.isFinite(hi)) return [hi - 1, hi]
  return fallback
}

export function gpuRasterStyle(meta) {
  const style = resolveRasterStyle(meta.style, meta), used = bandsUsedBy(style)
  const band = i => ['band', i + 1]
  const normalized = (value, raw) => {
    const range = safeStretchRange(raw)
    return ['^', ['clamp', ['/', ['-', value, range[0]], range[1] - range[0]], 0, 1], 1 / style.gamma]
  }
  const valid = ['all', ...used.map(i => ['<', ['abs', band(i)], 3.4e38])]
  const nodata = meta.rawNodata ?? meta.nodata
  if (Number.isFinite(nodata)) for (const i of used) valid.push(['!=', band(i), nodata])
  let color
  if (style.mode === 'index') {
    const a = band(used[0]), b = band(used[1]), sum = ['+', a, b]
    valid.push(['!=', sum, 0])
    const t = normalized(['/', ['-', a, b], sum], [-1, 1])
    const ramp = rampByName(style.ramp), stops = []
    for (let i = 0; i <= 32; i++) stops.push(i / 32, ['color', ...ramp(i / 32), 1])
    color = ['interpolate', ['linear'], t, ...stops]
  } else {
    const channels = used.map((i, c) => ['*', 255, normalized(band(i), meta.style?.ranges?.[c] ?? (meta.kind === 'dem' ? [meta.zMin ?? 0, meta.zMax] : [0, 255]))])
    color = ['color', channels[0], channels[1] ?? channels[0], channels[2] ?? channels[0], 1]
  }
  return { color: ['case', valid.length === 2 ? valid[1] : valid, color, ['color', 0, 0, 0, 0]] }
}


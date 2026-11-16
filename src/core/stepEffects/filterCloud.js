// What each step of Filter Cloud does to this project (FilterCloudModal.vue): the
// one-line effects under its numbered steps, in the order core/products/cloudEdit.js
// runs the enabled filters — range, voxel, isolated clusters, statistical outliers.
// Each line is a message (core/i18n); its words are in core/i18n/<lang>/filterCloud.js.
import { msg } from '../i18n/index.js'

const span = (lo, hi) => {
  const a = Number.isFinite(lo),
    b = Number.isFinite(hi)
  return a && b
    ? msg('filterCloud.span.between', { lo, hi })
    : a
      ? msg('filterCloud.span.atLeast', { lo })
      : b
        ? msg('filterCloud.span.atMost', { hi })
        : null
}
const length = (v) => msg('common.length', { v, unit: msg('common.units') })
const OFF = msg('common.off')

// project: { mergeCell } — the dense run's merge cell, 0 when unknown.
export function filterCloudEffects(s, { mergeCell = 0 } = {}) {
  const on = (id) => s.methods.includes(id)
  const z = span(s.zMin, s.zMax)
  const luma = span(s.lumaMin, s.lumaMax)
  const range = !on('range')
    ? msg('filterCloud.effect.range.off')
    : !z && !luma
      ? msg('filterCloud.effect.range.none')
      : msg('filterCloud.effect.range.kept', {
          limits: [
            z && msg('filterCloud.effect.range.elevation', { span: z }),
            luma && msg('filterCloud.effect.range.brightness', { span: luma }),
          ].filter(Boolean),
        })

  const cell = s.voxelCell > 0 ? s.voxelCell : mergeCell
  const voxel = !on('voxel')
    ? msg('filterCloud.effect.voxel.off')
    : cell > 0
      ? msg(s.voxelCell > 0 ? 'filterCloud.effect.voxel.cell' : 'filterCloud.effect.voxel.mergeCell', {
          cell: length(cell),
        })
      : msg('filterCloud.effect.voxel.spacing')

  const isolated = !on('isolated')
    ? msg('filterCloud.effect.isolated.off')
    : msg('filterCloud.effect.isolated.on', {
        cell: s.isolatedCell > 0 ? length(s.isolatedCell) : msg('filterCloud.effect.isolated.autoCell'),
        maxSupport: s.isolatedMaxSupport,
        minNeighbors: s.isolatedMinNeighbors,
      })

  const sor = !on('sor')
    ? msg('filterCloud.effect.sor.off')
    : msg('filterCloud.effect.sor.on', { k: s.sorK, ratio: s.sorStdRatio })
  return { range, voxel, isolated, sor }
}

// The steps' short facts for Filter Cloud's step chain (≤ SHORT_MAX characters).
export function filterCloudShorts(s, { mergeCell = 0 } = {}) {
  const on = (id) => s.methods.includes(id)
  const z = span(s.zMin, s.zMax),
    luma = span(s.lumaMin, s.lumaMax)
  const cell = s.voxelCell > 0 ? s.voxelCell : mergeCell
  return {
    range: !on('range')
      ? OFF
      : !z && !luma
        ? msg('filterCloud.short.range.none')
        : z
          ? msg(luma ? 'filterCloud.short.range.zAndBrightness' : 'filterCloud.short.range.z', { span: z })
          : msg('filterCloud.short.range.brightness'),
    voxel: !on('voxel')
      ? OFF
      : cell > 0
        ? msg('filterCloud.short.voxel.cell', { cell: length(cell) })
        : msg('filterCloud.short.voxel.spacing'),
    isolated: !on('isolated')
      ? OFF
      : msg('filterCloud.short.isolated', { maxSupport: s.isolatedMaxSupport, minNeighbors: s.isolatedMinNeighbors }),
    sor: !on('sor') ? OFF : msg('filterCloud.short.sor', { k: s.sorK, ratio: s.sorStdRatio }),
  }
}

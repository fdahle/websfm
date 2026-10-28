// What each step of Build DEM and Build Orthophoto does to this project (DemModal.vue,
// OrthoModal.vue): the one-line effects under their numbered steps. The grid line reads
// the store's size estimate (estimateRasterSize), the same one the run builds.
import { fmtCount, plural } from './format.js'

const fmtGsd = (g) => (g >= 100 ? g.toFixed(0) : String(+g.toPrecision(3)))

// The frame a raster is built in: 'project' (the project CRS) or 'local'.
export function frameText(crs, { projectCrs = null, hasScale = false } = {}) {
  if (crs === 'project') return projectCrs || 'the project CRS'
  return hasScale ? 'the local frame (metres)' : 'the local frame'
}

// `estimate`: 'loading' | null | { unavailable } | { width, height, gsd, approx }.
// `frame`: frameText's words, or null for an orthophoto on a DEM (its frame and grid).
export function gridEffect({ estimate, unit, frame, extent }) {
  const where = frame ? ` in ${frame}` : ", on the DEM's frame"
  const over = extent === 'all' ? ', over every point' : extent === 'core' ? ', over the dense core' : ''
  if (estimate === 'loading') return `Estimating the size${where}…`
  if (!estimate) return `A grid${where}${over}.`
  if (estimate.unavailable) return `A grid${where}${over}; its size is ${estimate.unavailable}.`
  return (
    `${estimate.approx ? '≈ ' : ''}${fmtCount(estimate.width)} × ${fmtCount(estimate.height)} px at ` +
    `${fmtGsd(estimate.gsd)} ${unit}${where}${over}.`
  )
}

const FILL = { idw: 'inverse distance', nearest: 'the nearest measured cell' }

// Build DEM. `source`: { kind, name, count, streamed, outdated } of the cloud the run
// reads (`outdated`: built on an input that has changed since, productSet.js).
export function demEffects(s, { source = null, estimate = null, unit, frame } = {}) {
  const ground = s.points === 'ground'
  const points = !source
    ? ground
      ? 'No classified cloud yet: Tools ▸ Point Cloud ▸ Classify ground makes one.'
      : 'No point cloud yet: build one first.'
    : `${plural(source.count, 'point')} of the ${source.kind === 'dense' ? 'dense' : 'sparse'} cloud` +
      `${source.name ? ` "${source.name}"` : ''}${source.streamed ? ' (streamed)' : ''}` +
      `${source.outdated ? ', which is outdated,' : ''} go into the grid: ` +
      (ground ? 'the ground class only, for a bare-earth DTM.' : 'every point, so the top surface (a DSM).')

  const grid = gridEffect({ estimate, unit, frame, extent: s.extent })

  const AGG = {
    max: 'the highest (the top surface)',
    median: 'the median (the surface at the cell, robust to outliers)',
    mean: 'the mean',
    min: 'the lowest (towards the ground)',
  }
  const cells = estimate && typeof estimate === 'object' && estimate.width ? estimate.width * estimate.height : 0
  const perCell = source && cells ? source.count / cells : null
  // Below about one point in two cells, most cells are empty until the fill step.
  const density =
    perCell == null
      ? ''
      : perCell >= 0.5
        ? `About ${plural(Math.max(1, Math.round(perCell)), 'point')} per cell; `
        : `About one point per ${fmtCount(Math.round(1 / perCell))} cells, so most cells are filled in step 4; `
  const cell = `${density}${density ? 'each' : 'Each'} cell takes ${AGG[s.aggregate] ?? s.aggregate} of its points.`

  const fill =
    s.fillMethod === 'none'
      ? `Off: cells no point fell in stay empty (nodata)${s.fillHoles ? ', except the enclosed gaps below' : ''}.`
      : `Empty cells within ${plural(s.fillRadius, 'cell')} of a measured one are filled by ${FILL[s.fillMethod]}` +
        `${s.fillHoles ? ', and every gap the survey surrounds is filled too' : ''}; gaps at the edge stay empty.`
  return { points, grid, cell, fill }
}

const SURFACE_WORD = { dem: 'DEM', mesh: 'mesh', plane: 'plane' }

const BLEND = {
  best: 'Per pixel, the photo whose depth matched best; the source can change from pixel to pixel.',
  average: 'Every photo that sees a pixel is averaged: smooth, but small misalignments ghost.',
}

// Build Orthophoto. `surface`: the chosen entry of the store's orthoSurfaces;
// `costCeiling`: the cost above which the depth maps already dropped pixels (or null).
export function orthoEffects(s, { surface = null, estimate = null, unit, frame, costCeiling = null } = {}) {
  const surfaceLine = !surface?.available
    ? 'No surface yet: build a DEM or a mesh first.'
    : `Every orthophoto cell takes its height from the ${SURFACE_WORD[s.surface] ?? surface.label}` +
      `${surface.detail ? ` (${surface.detail})` : ''}, and the photos are projected onto it.` +
      (s.surface === 'plane' ? ' Right only where the ground is flat.' : '')

  const grid = gridEffect({ estimate, unit, frame, extent: s.surface === 'dem' ? null : s.extent })

  const cost = !(s.maxCost > 0)
    ? 'colour from every matched pixel is used.'
    : costCeiling != null && s.maxCost >= costCeiling
      ? `the match-cost limit of ${s.maxCost} changes nothing: the depth maps already dropped every pixel ` +
        `above ${+costCeiling.toFixed(3)}.`
      : `colour is never taken where the depth map's match cost is above ${s.maxCost}.`
  const visibility =
    `A photo counts for a cell when its depth map puts the surface within ${s.depthTolRel} % of the cell's ` +
    `depth; ${cost}`

  const blend =
    s.blend !== 'mosaic'
      ? (BLEND[s.blend] ?? '')
      : `Each area comes from one photo, ${
          s.seamline === 'graphcut'
            ? 'with seams where neighbouring photos agree, around buildings and trees'
            : 'the one looking most straight down, with seams halfway between photo centres'
        }; ${s.colourBalance ? 'exposure evened out with one gain per photo and colour' : 'no exposure balancing'}; seams ${
          s.seamBlend === 'multiband'
            ? 'blended by frequency'
            : s.seamWidth > 0
              ? `cross-faded over ${s.seamWidth} % of the short side (at most 128 px)`
              : 'left hard'
        }.`

  const fill =
    s.fillMethod === 'none'
      ? 'Off: cells no photo saw stay transparent.'
      : `Gaps within ${plural(s.fillRadius, 'pixel')} of a sampled colour are filled by ` +
        `${s.fillMethod === 'nearest' ? 'the nearest sampled colour' : 'inverse distance'}, ` +
        'never outside the surface; larger unseen areas stay transparent.'
  return { surface: surfaceLine, grid, visibility, blend, fill }
}

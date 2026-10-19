// Windows of a block-built DEM's COG (SAT-3) as plain height grids — pure.
//
// A DEM past one plane keeps its full grid only in its COG; its level k is exactly
// 2^k cells of level 0 on a side (createCogBuilder halves with floor), same origin,
// GSD fullGsd · 2^k. A tool that needs heights asks for a world rectangle (or the
// whole DEM) and a cell budget, and gets the FINEST level whose window fits, as the
// same { width, height, gsd, originX, originY } grid every plane reader takes — so
// profile, volume, contours, terrain, clip and the ortho surface run unchanged on a
// window, and only the cell budget decides how fine.

// dem: { originX, originY, fullGsd } (the record); levels: [{ width, height }] of the
// COG, level 0 first; rect: { minX, minY, maxX, maxY } in the DEM's frame, or null
// for all of it; maxCells: the budget.
// → { level, window: [c0, r0, c1, r1] in that level's cells, width, height, gsd,
//     originX, originY } or null when the rectangle misses the DEM.
export function planDemWindow(dem, levels, rect, maxCells) {
  if (!levels?.length || !(dem?.fullGsd > 0)) return null
  let last = null
  for (let k = 0; k < levels.length; k++) {
    const { width: lw, height: lh } = levels[k]
    const gsd = dem.fullGsd * 2 ** k
    let c0 = 0, r0 = 0, c1 = lw, r1 = lh
    if (rect) {
      c0 = Math.max(0, Math.floor((rect.minX - dem.originX) / gsd))
      c1 = Math.min(lw, Math.ceil((rect.maxX - dem.originX) / gsd))
      r0 = Math.max(0, Math.floor((dem.originY - rect.maxY) / gsd))
      r1 = Math.min(lh, Math.ceil((dem.originY - rect.minY) / gsd))
      // A rectangle narrower than a cell still reads the cell it lies in.
      if (c1 === c0 && c0 < lw) c1 = c0 + 1
      if (r1 === r0 && r0 < lh) r1 = r0 + 1
      if (c1 <= c0 || r1 <= r0) return null
    }
    last = { level: k, window: [c0, r0, c1, r1], width: c1 - c0, height: r1 - r0, gsd,
      originX: dem.originX + c0 * gsd, originY: dem.originY - r0 * gsd }
    if (last.width * last.height <= maxCells) return last
  }
  return last
}

// The levels a COG of fullWidth × fullHeight has, as createCogBuilder makes them
// (planCogFromTiles: halve with floor until one tile covers the level).
export function demCogLevels(fullWidth, fullHeight, tileSize = 512) {
  const levels = [{ width: fullWidth, height: fullHeight }]
  for (;;) {
    const l = levels[levels.length - 1]
    if ((l.width <= tileSize && l.height <= tileSize) || (l.width <= 1 && l.height <= 1)) return levels
    levels.push({ width: Math.max(1, l.width >> 1), height: Math.max(1, l.height >> 1) })
  }
}

// A height grid's mask from its NaN nodata (1 = has a height).
export function maskFromNaN(data) {
  const mask = new Uint8Array(data.length)
  for (let i = 0; i < data.length; i++) mask[i] = Number.isNaN(data[i]) ? 0 : 1
  return mask
}

// What a worker needs to read a block-built DEM: its COG handle and grid, plain data
// (a File clones as a handle; nothing is read here).
export function demRef(dem) {
  return { cog: dem.cog, originX: dem.originX, originY: dem.originY, fullGsd: dem.fullGsd,
    fullWidth: dem.fullWidth, fullHeight: dem.fullHeight, tileSize: dem.tileSize ?? 512, crs: dem.crs ?? null }
}

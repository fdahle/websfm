import { sampleDemAtGcps, sampleDem } from '../core/eval/demCheck.js'
import { demRef } from '../core/products/demWindow.js'
import { readDemWindow } from '../workers/computeClient.js'

// sampleDemAtGcps for any computed DEM. A block-built one (SAT-3) is sampled at full
// resolution: each GCP reads the few cells around it from the COG (a window one cell
// wider than the point on each side, so the bilinear sample has its neighbours);
// any other DEM samples its plane, as before.
export async function sampleDemAtGcpsFull(dem, gcps) {
  if (!dem?.cog) return sampleDemAtGcps(dem, gcps)
  const ref = demRef(dem), g = dem.fullGsd
  return Promise.all((gcps || []).map(async (p) => {
    let demZ = null
    try {
      const w = await readDemWindow({ dem: ref, rect: { minX: p.x - g, maxX: p.x + g, minY: p.y - g, maxY: p.y + g }, maxCells: 64 })
      demZ = w ? sampleDem(w, p.x, p.y) : null
    } catch { demZ = null }
    const gcpZ = p.z ?? null
    return { gcpId: p.id, name: p.name, x: p.x, y: p.y, demZ, gcpZ, dz: demZ != null && gcpZ != null ? demZ - gcpZ : null }
  }))
}

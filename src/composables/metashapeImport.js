// Import ▸ Interoperability ▸ Metashape Cameras: one chunk of a Metashape XML export
// (core/io/metashapeXml.js) in the project's coordinate system. The CRS work needs the
// proj4 registry, so it lives here; the conversion itself is pure.
import proj4 from 'proj4'
import { ensureProjection, projDefinition, transformer, metresPerCrsUnit } from '../core/crs.js'
import { metashapeChunkToImport, ellipsoidOf, geographicDefOf } from '../core/io/metashapeXml.js'

// → metashapeChunkToImport's result, plus { crsNote } naming what the coordinates
// went through. Poses and marker coordinates are left out (with a warning) when the
// chunk's CRS cannot be resolved or has no ellipsoid this reader knows.
export async function planMetashapeImport(chunk, projectCrs) {
  const opts = { metric: false }
  const extra = []
  if (!chunk.crs.local) {
    try {
      if (!chunk.crs.epsg) throw new Error('the file names no EPSG code for it')
      await ensureProjection(chunk.crs.epsg)
      await ensureProjection(projectCrs)
      const def = projDefinition(chunk.crs.epsg)
      const ellipsoid = ellipsoidOf(def)
      if (!ellipsoid) throw new Error(`its ellipsoid is not one WebSfM knows (${def})`)
      const toProject = proj4(geographicDefOf(def), projectCrs)
      opts.ellipsoid = ellipsoid
      opts.toTarget = (lon, lat) => toProject.forward([lon, lat])
      opts.fromChunk = transformer(chunk.crs.epsg, projectCrs)
      opts.metric = metresPerCrsUnit(projectCrs) === 1
    } catch (err) {
      extra.push(
        `Camera poses and GCP coordinates left out: the chunk's coordinate system could not be used (${err?.message ?? err}).`,
      )
      opts.ellipsoid = null
    }
  }
  const out = metashapeChunkToImport(
    chunk.crs.local || opts.ellipsoid ? chunk : { ...chunk, crs: { ...chunk.crs, local: true } },
    opts,
  )
  out.warnings = [...extra, ...out.warnings.filter((w) => !(extra.length && /local frame/.test(w)))]
  return out
}

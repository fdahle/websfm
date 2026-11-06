// Camera centres of a reference run (COLMAP, Metashape) against the positions the bench
// scores WebSfM with: the config's reference file, else each photo's EXIF GPS, exactly
// the bench's choice (tests/bench/bench.js reconstruct()). Shared by colmap-ref.mjs and
// metashape-ref.mjs, so the tools are scored the same way.
import { join } from 'node:path'
import exifr from 'exifr'
import { cameraPositionCheck } from '../../src/core/eval/positionCheck.js'

export const stem = (n) => n.replace(/\.[^.]+$/, '').toLowerCase()

// model: readColmapModel's result; images: the photo folder; ref: loadReference's result.
// → { pc: the rounded positionCheck summary or null, positionSource }
export async function scoreCameraPositions(model, images, ref) {
  let positions = ref?.positions ? new Map(Object.entries(ref.positions)) : null
  if (!positions) {
    positions = new Map()
    for (const im of model.images) {
      const file = join(images, im.name.split('/').pop())
      const g = await exifr.gps(file).catch(() => null)
      const alt = await exifr.parse(file, ['GPSAltitude', 'GPSAltitudeRef']).catch(() => null)
      if (g && Number.isFinite(g.latitude) && alt?.GPSAltitude != null) {
        positions.set(stem(im.name.split('/').pop()), {
          lat: g.latitude,
          lon: g.longitude,
          alt: (alt.GPSAltitudeRef === 1 ? -1 : 1) * alt.GPSAltitude,
        })
      }
    }
  }
  const cams = new Map(model.images.map((im) => [stem(im.name.split('/').pop()), { R: im.R, t: im.t }]))
  const pc = cameraPositionCheck(cams, positions, { leverArm: ref?.leverArm ?? null })
  const r4 = (v) => (v == null ? null : Math.round(v * 1e4) / 1e4)
  return {
    pc: pc && {
      count: pc.count,
      scale: r4(pc.scale),
      rms3d: r4(pc.rms3d),
      rmsH: r4(pc.rmsH),
      rmsV: r4(pc.rmsV),
      medianH: r4(pc.medianH),
      p95H: r4(pc.p95H),
      maxH: r4(pc.maxH),
      medianV: r4(pc.medianV),
      p95V: r4(pc.p95V),
    },
    positionSource: ref?.positions ? 'reference file' : 'EXIF GPS',
  }
}

// The registered cameras as the bench writes them (`stages.recon.model`: name → { R, t }),
// so camera-check.mjs scores a reference run against ETH3D's or COLMAP's cameras too.
export const benchModel = (model) =>
  Object.fromEntries(model.images.map((im) => [im.name.split('/').pop(), { R: im.R, t: im.t }]))

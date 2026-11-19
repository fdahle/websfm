import { toRaw } from 'vue'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useSensorsStore } from '../stores/useSensorsStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { makeFrameModelResolver, makePinholeToMark, makeScanToPinhole } from '../core/sfm/displayFrame.js'
import { gcpPlaces, modelFromProject } from '../core/sfm/targetPredict.js'

// The GCP view's likely places (components/viewers/ViewerGcp.vue): where one GCP should
// be in each registered photo that has no mark of it yet, from its marks (two or more)
// or from its X, Y, Z through the georeference (core/sfm/targetPredict.js gcpPlaces).
// The marks go into each camera's pinhole frame and the places come back through the
// lens, as Detect targets does (useDetectTargets.js predict), in the marks' own pixel
// convention, so a place taken as it is lands where it was drawn.
//
// placesFor(gcp) → { from, viewCount, rejected, places: [{ imageId, px, py }] }, only the
// places at least `pad` px inside the photo; from null with no sparse model.
export function useGcpPlaces() {
  const imagesStore = useImagesStore()
  const sensors = useSensorsStore()
  const recon = useReconstructionStore()

  async function placesFor(gcp, { pad = 2 } = {}) {
    const none = { from: null, viewCount: 0, rejected: 0, places: [] }
    const cams = recon.mainSparseCloud?.cameras
    if (!gcp || !cams?.size) return none
    const frameModel = makeFrameModelResolver({
      calibration: recon.mainSparseCloud?.calibration ? toRaw(recon.mainSparseCloud.calibration) : null,
      summary: toRaw(recon.summary),
      sensors: sensors.sensors,
    })
    const images = imagesStore.images.filter((im) => im.enabled !== false && cams.has(im.uuid))
    const byId = new Map(images.map((im) => [im.id, im]))
    const camById = new Map(images.map((im) => [im.id, cams.get(im.uuid)]))
    const lens = new Map(images.map((im) => [im.id, frameModel(im)]))
    // Marks in the registered photos only: the others neither triangulate nor get a place.
    const observations = (gcp.observations ?? []).flatMap((o) => {
      const cam = camById.get(o.imageId)
      if (!cam || o.px == null || o.py == null) return []
      const p = makeScanToPinhole({ K: cam.K, ...lens.get(o.imageId) })(o.px, o.py)
      return [{ imageId: o.imageId, px: p.x, py: p.y }]
    })
    const g = recon.validGeoref
    const r = await gcpPlaces({
      gcp: { ...toRaw(gcp), observations },
      cameras: camById,
      toModel: g ? (p) => modelFromProject(g.sim, p) : null,
    })
    const places = []
    for (const p of r.places) {
      const img = byId.get(p.imageId)
      const m = makePinholeToMark({ K: camById.get(p.imageId).K, ...lens.get(p.imageId) })(p.u, p.v)
      const W = img.meta?.width,
        H = img.meta?.height
      if (!(m.x > pad && m.y > pad && m.x < W - pad && m.y < H - pad)) continue
      places.push({ imageId: p.imageId, px: m.x, py: m.y })
    }
    return { ...r, places }
  }

  return { placesFor }
}

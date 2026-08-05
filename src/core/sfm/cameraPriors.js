import { isGeographic } from '../crs.js'

// Marshal enabled, fully-3D camera positions into worker-safe BA priors. XY-only
// EXIF fixes remain useful to the map/matcher but cannot constrain a Euclidean 3D
// solve; geographic project coordinates likewise stay post-hoc only.
export function buildCameraPriors(poses, images, crs) {
  if (isGeographic(crs)) return []
  const uuidByImageId = new Map(images.map((image) => [image.id, image.uuid]))
  return poses
    .filter((pose) => pose.enabled !== false
      && Number.isFinite(pose.x) && Number.isFinite(pose.y) && Number.isFinite(pose.z))
    .map((pose) => ({
      uuid: uuidByImageId.get(pose.imageId),
      x: pose.x, y: pose.y, z: pose.z,
      accuracyX: pose.accuracyX, accuracyY: pose.accuracyY, accuracyZ: pose.accuracyZ,
      source: pose.source,
    }))
    .filter((pose) => pose.uuid != null)
}

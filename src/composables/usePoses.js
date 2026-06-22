import { ref, watch, computed } from 'vue'
import { useLog } from './useLog.js'
import { ensureProjection, transform } from '../utils/crs.js'
import * as opfs from '../utils/opfs.js'

// Camera poses (exterior orientation / extrinsics): one per image, used as
// georeferencing priors for bundle adjustment. Positions are stored in the
// project working CRS — exactly like GCPs/footprints — and re-projected when the
// CRS changes. Orientation angles (omega/phi/kappa, degrees) pass through.
//
// images:     Ref<Array>   — poses link to images by name (retroactive, like footprints)
// currentCrs: Ref<string>  — the project's working CRS
// persist:    { enabled, projectId }
const DEFAULT_ACC_XYZ   = 5.0   // position prior accuracy, project-CRS units (m)
const DEFAULT_ACC_ANGLE = 2.0   // orientation prior accuracy, degrees

export function usePoses({ images, currentCrs, persist } = {}) {
  const { log } = useLog()

  // [{ imageId, imageName, x, y, z, omega, phi, kappa, accXYZ, accAngle, source, enabled }]
  const poses = ref([])

  function isPersisting() {
    return persist?.enabled.value && !!persist?.projectId.value
  }

  async function save() {
    if (!isPersisting()) return
    await opfs.savePoses(persist.projectId.value, {
      crs: currentCrs.value,
      poses: poses.value,
    }).catch((err) => log(`Pose save failed — ${err?.message ?? err}`, 'error', 'Pose'))
  }

  // Resolve an image name to an id (case-insensitive, extension-tolerant) —
  // same matching as GCP observations / footprints.
  function resolveImageId(imageName) {
    if (!imageName) return null
    const lc = imageName.toLowerCase()
    const base = lc.replace(/\.[^.]+$/, '')
    const hit = images?.value.find((img) => {
      const n = img.name.toLowerCase()
      return n === lc || n.replace(/\.[^.]+$/, '') === base
    })
    return hit?.id ?? null
  }

  // Re-resolve every pose's imageId against the current image list (retroactive
  // association for poses imported before their images, or images added later).
  function resolveImageMatches() {
    let changed = false
    for (const p of poses.value) {
      const id = resolveImageId(p.imageName)
      if (id !== p.imageId) { p.imageId = id; changed = true }
    }
    if (changed) save()
  }

  // Keyed on id+name rather than a deep watch, so unrelated image mutations
  // (keypoints, masks, EXIF) don't trigger a full re-scan.
  if (images) {
    const imageSig = computed(() => images.value.map((i) => `${i.id}:${i.name}`).join('|'))
    watch(imageSig, resolveImageMatches)
  }

  // Add parsed poses (positions in `sourceCrs`), transforming into the project CRS.
  async function addPoses(rawPoses, sourceCrs) {
    const projCrs = currentCrs.value
    // If either CRS can't be resolved, transform() below would throw mid-loop —
    // bail with a clear log instead of rejecting silently into the caller.
    try {
      await ensureProjection(sourceCrs)
      await ensureProjection(projCrs)
    } catch (err) {
      log(`Pose import failed — could not resolve CRS (${err?.message ?? err})`, 'error', 'Pose')
      return 0
    }

    let added = 0
    let matched = 0
    for (const raw of rawPoses) {
      const [x, y, z] = transform([raw.x, raw.y, raw.z ?? 0], sourceCrs, projCrs)
      const imageId = resolveImageId(raw.imageName)
      if (imageId) matched++
      const existing = poses.value.find((p) => p.imageName === raw.imageName)
      const next = {
        imageId,
        imageName: raw.imageName,
        x, y, z: raw.z != null ? z : null,
        omega: raw.omega ?? null,
        phi:   raw.phi ?? null,
        kappa: raw.kappa ?? null,
        accXYZ:   raw.accXYZ ?? DEFAULT_ACC_XYZ,
        accAngle: raw.accAngle ?? DEFAULT_ACC_ANGLE,
        source: 'imported',
        enabled: true,
      }
      if (existing) Object.assign(existing, next)
      else { poses.value.push(next); added++ }
    }
    log(`Poses imported: ${added}${matched ? `, ${matched} matched to images` : ''} (from ${sourceCrs})`, 'success', 'Pose')
    await save()
    return added
  }

  function removePose(imageName) {
    const idx = poses.value.findIndex((p) => p.imageName === imageName)
    if (idx === -1) return
    poses.value.splice(idx, 1)
    save()
  }

  function clearPoses() {
    poses.value = []
    if (isPersisting()) opfs.deletePoses(persist.projectId.value).catch(() => {})
  }

  async function restorePoses(projectId, projectCrs) {
    poses.value = []
    const data = await opfs.loadPoses(projectId)
    if (!data?.poses?.length) return
    if (data.crs && projectCrs && data.crs !== projectCrs) {
      await ensureProjection(data.crs).catch(() => {})
      await ensureProjection(projectCrs).catch(() => {})
      poses.value = data.poses.map((p) => {
        const [x, y, z] = transform([p.x, p.y, p.z ?? 0], data.crs, projectCrs)
        return { ...p, x, y, z: p.z != null ? z : null }
      })
      await opfs.savePoses(projectId, { crs: projectCrs, poses: poses.value }).catch(() => {})
    } else {
      poses.value = data.poses
    }
    resolveImageMatches()
    log(`Poses restored: ${poses.value.length}`, 'success', 'Pose')
  }

  // Re-project all stored poses when the project CRS changes.
  async function reprojectPoses(fromCrs, toCrs) {
    if (!poses.value.length || fromCrs === toCrs) { await save(); return }
    await ensureProjection(fromCrs).catch(() => {})
    await ensureProjection(toCrs).catch(() => {})
    poses.value = poses.value.map((p) => {
      const [x, y, z] = transform([p.x, p.y, p.z ?? 0], fromCrs, toCrs)
      return { ...p, x, y, z: p.z != null ? z : null }
    })
    await save()
    log(`Poses re-projected to ${toCrs}`, 'info', 'Pose')
  }

  return {
    poses,
    addPoses,
    removePose,
    clearPoses,
    restorePoses,
    reprojectPoses,
  }
}

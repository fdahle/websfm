import { ref, watch, computed } from 'vue'
import { useLog } from './useLog.js'
import { ensureProjection, transform } from '../utils/crs.js'
import * as opfs from '../utils/opfs.js'

// images:     Ref<Array>   — image objects (footprints link to them by name)
// currentCrs: Ref<string>  — the project's working CRS (footprints are stored in it)
// persist:    { enabled, projectId }
export function useFootprints({ images, currentCrs, persist } = {}) {
  const { log } = useLog()

  // [{ id, name, imageId, imageName, rings: [[ [x,y], ... ], ...], enabled }]
  // rings are stored in the project CRS.
  const footprints = ref([])

  function isPersisting() {
    return persist?.enabled.value && !!persist?.projectId.value
  }

  async function save() {
    if (!isPersisting()) return
    await opfs.saveFootprints(persist.projectId.value, {
      crs: currentCrs.value,
      footprints: footprints.value,
    }).catch((err) => log(`Footprint save failed — ${err?.message ?? err}`, 'error', 'Footprint'))
  }

  // Resolve an image name to an in-memory image id (case-insensitive, tolerant of
  // extension differences). Same matching as GCP observations.
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

  function transformRings(rings, from, to) {
    return rings.map((ring) => ring.map((c) => transform([c[0], c[1]], from, to)))
  }

  // Re-resolve every footprint's imageId against the current image list. Lets a
  // footprint imported before its image (or images added later) link up.
  function resolveImageMatches() {
    let changed = false
    for (const fp of footprints.value) {
      const id = resolveImageId(fp.imageName)
      if (id !== fp.imageId) { fp.imageId = id; changed = true }
    }
    if (changed) save()
  }

  // Re-match whenever an image is added, removed, or renamed (retroactive
  // association). Keyed on id+name rather than a deep watch, so unrelated image
  // mutations (keypoints, masks, EXIF) don't trigger a full re-scan.
  if (images) {
    const imageSig = computed(() => images.value.map((i) => `${i.id}:${i.name}`).join('|'))
    watch(imageSig, resolveImageMatches)
  }

  // Add parsed footprints (given in `sourceCrs`), transforming rings into the project CRS.
  async function addFootprints(rawFootprints, sourceCrs) {
    const projCrs = currentCrs.value
    // If either CRS can't be resolved, transformRings() below would throw —
    // bail with a clear log instead of rejecting silently into the caller.
    try {
      await ensureProjection(sourceCrs)
      await ensureProjection(projCrs)
    } catch (err) {
      log(`Footprint import failed — could not resolve CRS (${err?.message ?? err})`, 'error', 'Footprint')
      return 0
    }

    let added = 0
    let matched = 0
    for (const raw of rawFootprints) {
      const rings = transformRings(raw.rings, sourceCrs, projCrs)
      const imageId = resolveImageId(raw.imageName)
      if (imageId) matched++
      footprints.value.push({
        id: crypto.randomUUID(),
        name: raw.name,
        imageId,
        imageName: raw.imageName,
        rings,
        enabled: true,
      })
      added++
    }
    log(`Footprints imported: ${added} polygon(s)${matched ? `, ${matched} matched to images` : ''} (from ${sourceCrs})`, 'success', 'Footprint')
    await save()
    return added
  }

  function removeFootprint(id) {
    const idx = footprints.value.findIndex((f) => f.id === id)
    if (idx === -1) return
    footprints.value.splice(idx, 1)
    save()
  }

  function clearFootprints() {
    footprints.value = []
    if (isPersisting()) opfs.deleteFootprints(persist.projectId.value).catch(() => {})
  }

  async function restoreFootprints(projectId, projectCrs) {
    footprints.value = []
    const data = await opfs.loadFootprints(projectId)
    if (!data?.footprints?.length) return
    // Stored CRS may differ from the current project CRS (e.g. CRS changed elsewhere).
    if (data.crs && projectCrs && data.crs !== projectCrs) {
      await ensureProjection(data.crs).catch(() => {})
      await ensureProjection(projectCrs).catch(() => {})
      footprints.value = data.footprints.map((f) => ({
        ...f,
        rings: transformRings(f.rings, data.crs, projectCrs),
      }))
      await opfs.saveFootprints(projectId, { crs: projectCrs, footprints: footprints.value }).catch(() => {})
    } else {
      footprints.value = data.footprints
    }
    resolveImageMatches()
    log(`Footprints restored: ${footprints.value.length} polygon(s)`, 'success', 'Footprint')
  }

  // Re-project all stored footprints when the project CRS changes.
  async function reprojectFootprints(fromCrs, toCrs) {
    if (!footprints.value.length || fromCrs === toCrs) { await save(); return }
    await ensureProjection(fromCrs).catch(() => {})
    await ensureProjection(toCrs).catch(() => {})
    footprints.value = footprints.value.map((f) => ({
      ...f,
      rings: transformRings(f.rings, fromCrs, toCrs),
    }))
    await save()
    log(`Footprints re-projected to ${toCrs}`, 'info', 'Footprint')
  }

  return {
    footprints,
    addFootprints,
    removeFootprint,
    clearFootprints,
    restoreFootprints,
    reprojectFootprints,
  }
}

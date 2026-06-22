import { ref } from 'vue'
import { createImage } from '../utils/image.js'
import { extractMetadata } from '../utils/metadata.js'
import { detectKeypoints } from '../utils/detection.js'
import { useLog } from './useLog.js'
import * as opfs from '../utils/opfs.js'

// persist: { enabled: Ref<bool>, projectId: Ref<string|null>, sync: (images) => void }
export function useImages({ persist } = {}) {
  const { log } = useLog()

  const images = ref([])
  const selectedId = ref(null)

  function isPersisting() {
    return persist?.enabled.value && !!persist?.projectId.value
  }

  function imageById(id) {
    return images.value.find((img) => img.id === id) || null
  }

  function selectImage(id) {
    selectedId.value = id
  }

  function addImages(files) {
    let added = 0
    for (const file of files) {
      const item = createImage(file)
      if (images.value.some((img) => img.id === item.id)) {
        log(`Skip duplicate: ${file.name}`, 'warn', 'Images')
        continue
      }
      images.value.push(item)
      added++
      log(`Added image: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`, 'info', 'Images')

      if (isPersisting()) {
        opfs.saveImage(persist.projectId.value, item.uuid, file)
          .catch((err) => log(`OPFS save failed: ${file.name} — ${err?.message ?? err}`, 'error', 'Images'))
      }

      extractMetadata(file, item.url)
        .then((meta) => {
          const found = images.value.find((img) => img.id === item.id)
          if (found) {
            found.meta = meta
            found.loading = false
            const cam = [meta.make, meta.model].filter(Boolean).join(' ') || 'unknown camera'
            const dim = meta.width && meta.height ? ` ${meta.width}×${meta.height}` : ''
            log(`Metadata: ${file.name} — ${cam}${dim}`, 'success', 'Metadata')
            if (isPersisting()) persist.sync(images.value)
          }
        })
        .catch((err) => {
          const found = images.value.find((img) => img.id === item.id)
          if (found) found.loading = false
          log(`Metadata failed: ${file.name} — ${err?.message ?? err}`, 'error', 'Metadata')
          if (isPersisting()) persist.sync(images.value)
        })
    }
    if (added > 1) log(`Added ${added} images`, 'success', 'Images')
    if (isPersisting()) persist.sync(images.value)
  }

  function removeImage(id, onRemoved) {
    const idx = images.value.findIndex((img) => img.id === id)
    if (idx !== -1) {
      const img = images.value[idx]
      URL.revokeObjectURL(img.url)
      images.value.splice(idx, 1)
      if (selectedId.value === id) selectedId.value = null
      log(`Removed image: ${img.name}`, 'info', 'Images')
      if (isPersisting()) {
        const pid = persist.projectId.value
        opfs.deleteImage(pid, img.uuid).catch(() => {})
        opfs.deleteKeypoints(pid, img.uuid).catch(() => {})
        opfs.deleteDescriptors(pid, img.uuid).catch(() => {})
        opfs.deleteMask(pid, img.uuid).catch(() => {})
        opfs.deleteDepth(pid, img.uuid).catch(() => {})
        persist.sync(images.value)
      }
      onRemoved?.(id)
    }
  }

  function updateMask(imageId, dataUrl) {
    const img = imageById(imageId)
    if (!img) return
    img.mask = dataUrl ? { dataUrl } : null
    log(dataUrl ? `Mask saved: ${img.name}` : `Mask cleared: ${img.name}`, 'info', 'Images')
    if (isPersisting()) {
      const pid = persist.projectId.value
      if (dataUrl) opfs.saveMask(pid, img.uuid, dataUrl).catch(() => {})
      else opfs.deleteMask(pid, img.uuid).catch(() => {})
      persist.sync(images.value)
    }
  }

  function updateDepth(imageId, dataUrl) {
    const img = imageById(imageId)
    if (!img) return
    img.depth = dataUrl ? { dataUrl } : null
    log(dataUrl ? `Depth map saved: ${img.name}` : `Depth map cleared: ${img.name}`, 'info', 'Images')
    if (isPersisting()) {
      const pid = persist.projectId.value
      if (dataUrl) opfs.saveDepth(pid, img.uuid, dataUrl).catch(() => {})
      else opfs.deleteDepth(pid, img.uuid).catch(() => {})
      persist.sync(images.value)
    }
  }

  async function detectOne(id, settings = {}, onDetected) {
    const img = images.value.find((i) => i.id === id)
    if (!img || img.kpStatus === 'running') return
    img.kpStatus = 'running'
    log(`SIFT start: ${img.name}`, 'info', 'SIFT')
    try {
      const res = await detectKeypoints(img.url, settings)
      const found = images.value.find((i) => i.id === id)
      if (found) {
        found.keypoints   = res.keypoints
        found.descriptors = res.descriptors   // keep in-memory for non-persistent matching
        found.kpCount  = res.keypoints.length
        found.kpMs     = Math.round(res.ms)
        found.kpStatus = 'done'
        log(`SIFT done: ${found.name} — ${found.kpCount} keypoints in ${found.kpMs} ms`, 'success', 'SIFT')
        if (isPersisting()) {
          const pid = persist.projectId.value
          opfs.saveKeypoints(pid, found.uuid, found.keypoints).catch(() => {})
          opfs.saveDescriptors(pid, found.uuid, res.descriptors).catch(() => {})
          persist.sync(images.value)
        }
        onDetected?.(id)
      }
    } catch (err) {
      log(`SIFT error: ${img.name} — ${err?.message ?? err}`, 'error', 'SIFT')
      const found = images.value.find((i) => i.id === id)
      if (found) found.kpStatus = 'error'
    }
  }

  async function detectAll(settings = {}, onDetected, onProgress) {
    const pending = settings.overwrite
      ? images.value
      : images.value.filter((img) => img.kpStatus !== 'done')
    const total = pending.length
    log(`SIFT batch: ${total} image(s) queued`, 'info', 'SIFT')
    let done = 0
    for (const img of pending) {
      await detectOne(img.id, settings, onDetected)
      done++
      onProgress?.(done, total, img.name)
    }
    log('SIFT batch complete', 'success', 'SIFT')
  }

  function clearKeypoints(id) {
    const img = imageById(id)
    if (!img) return
    img.keypoints = []
    img.kpCount   = 0
    img.kpMs      = 0
    img.kpStatus  = null
    log(`Keypoints cleared: ${img.name}`, 'info', 'SIFT')
    if (isPersisting()) {
      const pid = persist.projectId.value
      opfs.deleteKeypoints(pid, img.uuid).catch(() => {})
      opfs.deleteDescriptors(pid, img.uuid).catch(() => {})
      persist.sync(images.value)
    }
  }

  function clearAll(onCleared) {
    const n = images.value.length
    for (const img of images.value) URL.revokeObjectURL(img.url)
    images.value = []
    selectedId.value = null
    log(`Session cleared (${n} image${n !== 1 ? 's' : ''} removed)`, 'warn', 'Images')
    if (isPersisting()) persist.sync([])
    onCleared?.()
  }

  // Restore images from OPFS project records (used on session load / project switch)
  async function restoreImages(records, projectId) {
    for (const img of images.value) URL.revokeObjectURL(img.url)
    images.value = []
    selectedId.value = null

    for (const record of records) {
      try {
        const blob = await opfs.loadImageBlob(projectId, record.uuid)
        const url = URL.createObjectURL(blob)
        const img = {
          id: record.id,
          uuid: record.uuid,
          name: record.name,
          url,
          file: null,
          meta: record.meta,
          sensorId: record.sensorId ?? null,
          loading: false,
          keypoints: [],
          kpStatus: record.kpStatus,
          kpCount: record.kpCount || 0,
          kpMs: record.kpMs || 0,
          mask: null,
          depth: null,
        }
        if (record.kpStatus === 'done') {
          const kps = await opfs.loadKeypoints(projectId, record.uuid)
          if (kps) img.keypoints = kps
        }
        if (record.hasMask) {
          const maskDataUrl = await opfs.loadMaskDataUrl(projectId, record.uuid)
          if (maskDataUrl) img.mask = { dataUrl: maskDataUrl }
        }
        if (record.hasDepth) {
          const depthDataUrl = await opfs.loadDepthDataUrl(projectId, record.uuid)
          if (depthDataUrl) img.depth = { dataUrl: depthDataUrl }
        }
        images.value.push(img)
      } catch (err) {
        log(`Restore failed: ${record.name} — ${err?.message ?? err}`, 'error', 'Project')
      }
    }
    log(`Project loaded: ${records.length} image${records.length !== 1 ? 's' : ''}`, 'success', 'Project')
  }

  return {
    images,
    selectedId,
    imageById,
    selectImage,
    addImages,
    removeImage,
    updateMask,
    updateDepth,
    detectOne,
    detectAll,
    clearKeypoints,
    clearAll,
    restoreImages,
  }
}

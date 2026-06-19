import { ref } from 'vue'
import { createImage } from '../utils/image.js'
import { extractMetadata } from '../utils/metadata.js'
import { detectKeypoints } from '../utils/sift.js'
import { useLog } from './useLog.js'

export function useImages() {
  const { log } = useLog()

  const images = ref([])
  const selectedId = ref(null)

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
        log(`Skip duplicate: ${file.name}`, 'warn')
        continue
      }
      images.value.push(item)
      added++
      log(`Added image: ${file.name} (${(file.size / 1024).toFixed(0)} KB)`)
      extractMetadata(file, item.url)
        .then((meta) => {
          const found = images.value.find((img) => img.id === item.id)
          if (found) {
            found.meta = meta
            found.loading = false
            const cam = [meta.make, meta.model].filter(Boolean).join(' ') || 'unknown camera'
            const dim = meta.width && meta.height ? ` ${meta.width}×${meta.height}` : ''
            log(`Metadata: ${file.name} — ${cam}${dim}`, 'success')
          }
        })
        .catch((err) => {
          const found = images.value.find((img) => img.id === item.id)
          if (found) found.loading = false
          log(`Metadata failed: ${file.name} — ${err?.message ?? err}`, 'error')
        })
    }
    if (added > 1) log(`Added ${added} images`, 'success')
  }

  function removeImage(id, onRemoved) {
    const idx = images.value.findIndex((img) => img.id === id)
    if (idx !== -1) {
      const name = images.value[idx].name
      URL.revokeObjectURL(images.value[idx].url)
      images.value.splice(idx, 1)
      if (selectedId.value === id) selectedId.value = null
      log(`Removed image: ${name}`)
      onRemoved?.(id)
    }
  }

  function updateMask(imageId, dataUrl) {
    const img = imageById(imageId)
    if (!img) return
    img.mask = dataUrl ? { dataUrl } : null
    log(dataUrl ? `Mask saved: ${img.name}` : `Mask cleared: ${img.name}`)
  }

  async function detectOne(id, settings = {}, onDetected) {
    const img = images.value.find((i) => i.id === id)
    if (!img || img.kpStatus === 'running') return
    img.kpStatus = 'running'
    log(`SIFT start: ${img.name}`)
    try {
      const res = await detectKeypoints(img.url, settings)
      const found = images.value.find((i) => i.id === id)
      if (found) {
        found.keypoints = res.keypoints
        found.kpCount = res.keypoints.length
        found.kpMs = Math.round(res.ms)
        found.kpStatus = 'done'
        log(`SIFT done: ${found.name} — ${found.kpCount} keypoints in ${found.kpMs} ms`, 'success')
        onDetected?.(id)
      }
    } catch (err) {
      log(`SIFT error: ${img.name} — ${err?.message ?? err}`, 'error')
      const found = images.value.find((i) => i.id === id)
      if (found) found.kpStatus = 'error'
    }
  }

  async function detectAll(settings = {}, onDetected) {
    const pending = images.value.filter((img) => img.kpStatus !== 'done')
    log(`SIFT batch: ${pending.length} image(s) queued`)
    for (const img of pending) {
      await detectOne(img.id, settings, onDetected)
    }
    log('SIFT batch complete', 'success')
  }

  function clearAll(onCleared) {
    const n = images.value.length
    for (const img of images.value) URL.revokeObjectURL(img.url)
    images.value = []
    selectedId.value = null
    log(`Session cleared (${n} image${n !== 1 ? 's' : ''} removed)`, 'warn')
    onCleared?.()
  }

  return {
    images,
    selectedId,
    imageById,
    selectImage,
    addImages,
    removeImage,
    updateMask,
    detectOne,
    detectAll,
    clearAll,
  }
}

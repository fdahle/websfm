import { markRaw, ref } from 'vue'
import * as opfs from '../../utils/opfs.js'
import { makeThumbnail } from '../../workers/thumbnailClient.js'
import { createKeyedQueue, QueueCancelled } from '../../utils/keyedQueue.js'
import { THUMB_MAX_DIM, SOURCE_UNREADABLE } from '../../utils/thumbnail.js'

// Per-image list thumbnails (TODO ▸ SC-8), composed into useImagesStore. Lists,
// tables, grids and the 3D camera glyphs show `img.thumb` — a ≤256 px JPEG, shaped
// `{ blob, url }` like a mask preview — never the full-resolution `img.url`.
//
// Lifecycle:
//   • Ingest asks for one per image in the background, from the pixels it already
//     holds (the dropped File; a TIFF's quick transcode preview — never the TIFF).
//   • A restore makes NONE. `img.thumb` starts null and is filled when something
//     asks (a row scrolling into view, the 3D view): first from the persisted copy
//     (`images-derived/{uuid}.thumb`, File-backed, nothing read until an <img>
//     decodes it), else generated from what the viewer shows (`img.url` — for a
//     transcoded TIFF that is the display JPEG) and persisted. Older projects heal
//     this way; opening a 5,000-image project decodes nothing.
//   • Generation runs in a dedicated worker (workers/thumbnail.worker.js), at most
//     THUMB_CONCURRENCY at a time; a row in view jumps the background backlog.
//   • A thumbnail <img> that fails to load reports `reportThumbnailError`: the thumb
//     is dropped and regenerated from the display source once per session (which
//     also overwrites the stored copy); a second failure leaves the placeholder.
//     The full image is unaffected — that is `reportImageLoadError`'s job, and it is
//     called here only when the display URL itself turns out to be unreadable.
export const THUMB_CONCURRENCY = 2

export function createImageThumbnails({
  imageById, currentProjectId, isPersisting, trackWrite, log, healImage,
  make = makeThumbnail, storage = opfs,
}) {
  const queue = createKeyedQueue({ concurrency: THUMB_CONCURRENCY })
  // Bumped whenever an image gains or loses a thumbnail — the 3D view watches this
  // one number instead of every image's `thumb`.
  const version = ref(0)
  let generation = 0
  const failed = new Set()   // uuid → generation failed this session; no retry loop
  const healed = new Set()   // uuid → a broken thumbnail was already regenerated once

  function release(p) { if (p?.url) URL.revokeObjectURL(p.url) }
  function attach(img, blob) {
    release(img.thumb)
    img.thumb = markRaw({ blob, url: URL.createObjectURL(blob) })
    version.value++
  }
  function drop(img) {
    if (!img?.thumb) return
    release(img.thumb)
    img.thumb = null
    version.value++
  }

  async function produce(id, source, regenerate, gen) {
    const stale = () => gen !== generation
    let img = imageById(id)
    if (!img || stale()) return null
    if (img.thumb && !regenerate) return img.thumb
    const pid = currentProjectId()
    const persist = !!pid && isPersisting()
    const uuid = img.uuid

    if (persist && !regenerate && !source) {
      const file = await storage.loadImageDerivedBlob(pid, uuid, 'thumb')
      img = imageById(id)
      if (!img || stale()) return null
      if (img.thumb) return img.thumb
      if (file?.size > 0) { attach(img, file); return img.thumb }
    }

    // A TIFF still transcoding has no displayable URL yet; the row asks again once
    // `img.url` changes. A failed decode will never have one.
    const from = source ?? (img.previewPending || img.previewFailed ? null : img.url)
    if (!from) return null
    const hint = img.meta?.width > 0 && img.meta?.height > 0
      ? { width: img.meta.width, height: img.meta.height } : null
    const { blob } = await make(from, { maxDim: THUMB_MAX_DIM, hint })
    img = imageById(id)
    if (!img || stale()) return null
    attach(img, blob)
    if (persist && currentProjectId() === pid) {
      trackWrite(storage.saveImageDerived(pid, uuid, 'thumb', blob)
        .catch((err) => log(`Thumbnail save failed: ${img.name} — ${err?.message ?? err}`, 'warn', 'Images')))
    }
    return img.thumb
  }

  // → Promise<thumb | null>. Never rejects: a thumbnail is a convenience, and every
  // caller falls back to a placeholder.
  function requestThumbnail(img, { source = null, urgent = false, regenerate = false } = {}) {
    if (!img) return Promise.resolve(null)
    if (img.thumb && !regenerate) return Promise.resolve(img.thumb)
    if (!source && !regenerate && failed.has(img.uuid)) return Promise.resolve(null)
    const id = img.id, uuid = img.uuid, name = img.name, gen = generation
    return queue.request(uuid, () => produce(id, source, regenerate, gen), { urgent })
      .catch(async (err) => {
        if (err instanceof QueueCancelled || gen !== generation) return null
        const message = err?.message ?? String(err)
        // The display URL itself is dead (its file moved, OPFS evicted): that is the
        // image's problem, healed the usual way; one retry if it came back.
        if (!source && message.startsWith(SOURCE_UNREADABLE) && healImage && await healImage(id)) {
          try { return await produce(id, null, regenerate, gen) } catch { /* fall through */ }
        }
        if (gen !== generation) return null
        failed.add(uuid)
        log(`Thumbnail unavailable: ${name} — ${message}`, 'warn', 'Images')
        return null
      })
  }

  // A thumbnail <img> failed to load (truncated stored copy, revoked URL).
  function reportThumbnailError(id) {
    const img = imageById(id)
    if (!img?.thumb) return
    drop(img)
    if (healed.has(img.uuid)) { failed.add(img.uuid); return }
    healed.add(img.uuid)
    requestThumbnail(img, { regenerate: true, urgent: true })
  }

  // Project switch / clear: forget the session's bookkeeping and drop queued work.
  // Jobs already running see the generation move and discard their result.
  function reset() {
    generation++
    queue.cancelPending('project changed')
    failed.clear()
    healed.clear()
  }

  return { version, release, requestThumbnail, reportThumbnailError, reset }
}

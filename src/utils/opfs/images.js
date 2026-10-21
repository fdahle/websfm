// Per-image files: originals, derived blobs (display, compute, thumb, pyramid),
// masks and depth-map previews.
import { trackPersistence, ignoreMissing } from '../persistence.js'
import { DEPTH_BIN_KEYS } from '../../core/dense/depthMapCodec.js'
import { getSubDir, writeFileIn } from './base.js'

// ── Images ────────────────────────────────────────────────────────────────────

export async function saveImage(projectId, uuid, file) {
  return trackPersistence('saveImage:' + String(projectId) + ':' + String(uuid), async () => {
    const dir = await getSubDir(projectId, 'images')
    await writeFileIn(dir, uuid, file)
  })
}

// Directory handles for one batch of reads (a project restore): the root → project →
// subdirectory walk once instead of once per file. A per-file walk is seven OPFS round
// trips, and an origin's OPFS operations queue behind each other — quarry's 347
// images held every other store's restore for ~9 s. Valid only while those
// directories exist, so pass them to the loaders for that batch and drop them.
export async function projectSubDirs(projectId, names) {
  const out = {}
  for (const n of names) out[n] = await getSubDir(projectId, n)
  return out
}

export async function loadImageBlob(projectId, uuid, dirs = null) {
  const dir = dirs?.images ?? (await getSubDir(projectId, 'images'))
  const fh = await dir.getFileHandle(uuid)
  return fh.getFile()
}

export async function deleteImage(projectId, uuid) {
  return trackPersistence('deleteImage:' + String(projectId) + ':' + String(uuid), async () => {
    try {
      const dir = await getSubDir(projectId, 'images')
      await dir.removeEntry(uuid)
    } catch (error) {
      ignoreMissing(error)
    }
  })
}

// ── Derived (transcoded) image blobs ──────────────────────────────────────────
// Pure cache of the TIFF→JPEG/PNG transcode. `kind` is 'display' (JPEG, the
// viewer <img>) or 'compute' (lossless PNG, detection/dense). Recomputable
// from the immutable original at any time, so absence is never an error.
// NOTE: this cache assumes fixed transcode params (jpegQuality etc.); if those
// ever become user-configurable it needs a version/params check to invalidate.
// `kind` 'thumb' is the small list thumbnail (≤256 px JPEG, utils/thumbnail.js)
// that every image gets, TIFF or not — same rules: recomputable, absence heals
// lazily (useImagesStore.requestThumbnail).

const DERIVED_KINDS = ['display', 'compute', 'thumb', 'pyramid']

async function derivedName(uuid, kind) {
  return `${uuid}.${DERIVED_KINDS.includes(kind) ? kind : 'display'}`
}

export async function saveImageDerived(projectId, uuid, kind, blob) {
  return trackPersistence(
    'saveImageDerived:' + String(projectId) + ':' + String(uuid) + ':' + String(kind),
    async () => {
      const dir = await getSubDir(projectId, 'images-derived')
      await writeFileIn(dir, await derivedName(uuid, kind), blob)
    },
  )
}

export async function loadImageDerivedBlob(projectId, uuid, kind) {
  try {
    const dir = await getSubDir(projectId, 'images-derived')
    const fh = await dir.getFileHandle(await derivedName(uuid, kind))
    return await fh.getFile()
  } catch {
    return null
  }
}

export async function deleteImageDerived(projectId, uuid) {
  return trackPersistence('deleteImageDerived:' + String(projectId) + ':' + String(uuid), async () => {
    try {
      const dir = await getSubDir(projectId, 'images-derived')
      for (const kind of DERIVED_KINDS) await dir.removeEntry(await derivedName(uuid, kind)).catch(ignoreMissing)
    } catch (error) {
      ignoreMissing(error)
    }
  })
}

// ── Masks ─────────────────────────────────────────────────────────────────────
// Mask and depth previews are PNG Blobs (core/mask.js). A load returns the OPFS
// File itself: file-backed, nothing is read until a viewer or worker decodes it,
// and nothing sits on the V8 heap. Reading them as data URLs at restore held every
// image's preview as a base64 string for the whole session.

export async function saveMask(projectId, uuid, blob) {
  return trackPersistence('saveMask:' + String(projectId) + ':' + String(uuid), async () => {
    const dir = await getSubDir(projectId, 'masks')
    await writeFileIn(dir, uuid + '.png', blob)
  })
}

export async function loadMaskFile(projectId, uuid, dirs = null) {
  try {
    const dir = dirs?.masks ?? (await getSubDir(projectId, 'masks'))
    return await (await dir.getFileHandle(uuid + '.png')).getFile()
  } catch {
    return null
  }
}

export async function deleteMask(projectId, uuid) {
  return trackPersistence('deleteMask:' + String(projectId) + ':' + String(uuid), async () => {
    try {
      const dir = await getSubDir(projectId, 'masks')
      await dir.removeEntry(uuid + '.png')
    } catch (error) {
      ignoreMissing(error)
    }
  })
}

// ── Depth maps (display previews) ─────────────────────────────────────────────
// The per-image preview PNG shown in the viewer. The heavy float planes behind
// it are a separate concern — see "Depth-map planes" below.

export async function saveDepth(projectId, uuid, blob) {
  return trackPersistence('saveDepth:' + String(projectId) + ':' + String(uuid), async () => {
    const dir = await getSubDir(projectId, 'depthmaps')
    await writeFileIn(dir, uuid + '.png', blob)
  })
}

export async function loadDepthFile(projectId, uuid, dirs = null) {
  try {
    const dir = dirs?.depthmaps ?? (await getSubDir(projectId, 'depthmaps'))
    return await (await dir.getFileHandle(uuid + '.png')).getFile()
  } catch {
    return null
  }
}

export async function deleteDepth(projectId, uuid) {
  return trackPersistence('deleteDepth:' + String(projectId) + ':' + String(uuid), async () => {
    try {
      const dir = await getSubDir(projectId, 'depthmaps')
      await dir.removeEntry(uuid + '.png').catch(ignoreMissing)
      // The float planes belong to the same image — drop them together, or an
      // image removal would leave orphaned (and much larger) sidecars behind.
      for (const key of DEPTH_BIN_KEYS) {
        await dir.removeEntry(`${uuid}.${key}.bin`).catch(ignoreMissing)
      }
    } catch (error) {
      ignoreMissing(error)
    }
  })
}

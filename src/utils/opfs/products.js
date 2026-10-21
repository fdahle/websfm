// Raster products (DEM, orthophoto).
import { trackPersistence, persistenceLock, ignoreMissing } from '../persistence.js'
import { writeBinaryDocument, readBinaryDocument } from '../binaryDocument.js'
import { dataUrlToBlob } from '../../core/mask.js'
import { getProjectDir, getSubDir, readBin, readJson, writeBin, writeJson } from './base.js'

// ── Products (DEM / orthophoto rasters) ──────────────────────────────────────
// Recomputable but expensive, so persisted like other project data. Metadata
// (dimensions, geotransform, CRS) goes in products/{kind}.json; the binary parts
// are generation files of that document (binaryDocument.js), the preview PNG among
// them. DEM: Float32 heights (`data`) + Uint8 validity (`mask`), read at open (≤ 4,096²);
// a DEM finer than that (SAT-3) also has its full grid as a Float32 COG (`cog`), kept
// like the ortho's, and `data`/`mask` are that COG's overview.
// Ortho: its Cloud-Optimized GeoTIFF (`cog`, RGBA, any size) — opened as a File
// handle at load, never read: the viewer and the map pull its tiles, exports copy or
// stream it. Its record carries `cogSaved` ({ name, bytes }, the committed file),
// which the next save of the same ortho (a rename) reuses instead of rewriting GBs.

function validateProduct(kind, product) {
  const n = product.width * product.height
  if (!Number.isSafeInteger(product.width) || product.width <= 0
      || !Number.isSafeInteger(product.height) || product.height <= 0 || !Number.isSafeInteger(n)
      || (kind === 'dem' ? !(product.data instanceof Float32Array) || product.data.length !== n
        || !(product.mask instanceof Uint8Array) || product.mask.length !== n
        : !(product.cog instanceof Blob) && !product.cogSaved)) {
    throw new Error('Incomplete or invalid raster product')
  }
}

// → the committed { key: { name, bytes } } files (the store records the ortho's cog).
export async function saveProduct(projectId, kind, product) {
  return trackPersistence('saveProduct:' + String(projectId) + ':' + String(kind), async () => {
    validateProduct(kind, product)
    return persistenceLock(`product:${projectId}:${kind}`, async () => {
      const dir = await getSubDir(projectId, 'products')
      // The preview PNG is a sidecar file (a Blob, written as is), never a string in
      // the JSON: a 4096² preview was ~100 MB of base64 parsed back at every open.
      const { data, mask, cog, cogSaved, previewBlob, previewUrl: _url, ...meta } = product
      // Pass views, not their underlying buffer: subarrays may have a nonzero offset.
      const cogPart = cogSaved ? { reuse: cogSaved } : cog
      const buffers = kind === 'dem' ? { data, mask, ...(cogPart ? { cog: cogPart } : {}) } : { cog: cogPart }
      buffers.preview = previewBlob ?? null
      let res = await writeBinaryDocument(dir, `${kind}.json`, meta, buffers, { writeJson, writeBin })
      // The reused file went missing (another tab's save collected it): write it out.
      if (res.stale && cog instanceof Blob) {
        res = await writeBinaryDocument(dir, `${kind}.json`, meta, { ...buffers, cog }, { writeJson, writeBin })
      }
      if (res.stale) throw new Error(`Saved ${kind === 'dem' ? 'DEM' : 'orthophoto'} file is missing`)
      if (kind === 'dem' && !cogPart) return {}
      // The committed COG as a File: the store points the record at it, so the
      // worker's in-memory Blob can go and a later save can reuse the file.
      const saved = await productFile(dir, { binaryFiles: res.files }, 'cog')
      return { cog: saved.file, cogSaved: saved.saved }
    })
  })
}

// The committed file behind a product's `key` part, as a File (a handle; nothing read).
async function productFile(dir, meta, key) {
  const f = meta.binaryFiles?.[key]
  if (!f?.name || /[/\\]/.test(f.name) || !Number.isSafeInteger(f.bytes)) return null
  const file = await (await dir.getFileHandle(f.name)).getFile()
  if (file.size !== f.bytes) throw new Error(`Incomplete saved buffer: ${key}`)
  return { file, saved: { name: f.name, bytes: f.bytes } }
}

// → the product, null, or { outdated: true } for an ortho saved before orthophotos
// were stored as a COG (beta: its whole-plane RGBA shape is no longer read; rebuild).
export async function loadProduct(projectId, kind) {
  return persistenceLock(`product:${projectId}:${kind}`, async () => {
    try {
      const dir = await getSubDir(projectId, 'products')
      const meta = await readJson(dir, `${kind}.json`)
      if (!meta) return null
      if (kind !== 'dem') {
        const cog = await productFile(dir, meta, 'cog')
        if (!cog) return { outdated: true }
        // The preview is read (a few MB at most): a blob: URL over the generation file
        // itself would die when a later save collects that file.
        const preview = await productFile(dir, meta, 'preview').catch(() => null)
        const previewBytes = preview ? await preview.file.arrayBuffer() : null
        delete meta.binaryFiles
        const product = { ...meta, cog: cog.file, cogSaved: cog.saved }
        validateProduct(kind, product)
        return previewBytes ? { ...product, previewBlob: new Blob([previewBytes], { type: 'image/png' }) } : product
      }
      // A full-resolution COG is opened as a handle, never read.
      const cog = meta.binaryFiles?.cog ? await productFile(dir, meta, 'cog') : null
      if (meta.binaryFiles?.cog && !cog) return null
      const { cog: _cogFile, ...planeFiles } = meta.binaryFiles ?? {}
      const buffers = meta.binaryFiles ? await readBinaryDocument(dir, { ...meta, binaryFiles: planeFiles }, readBin) : null
      delete meta.binaryFiles
      if (cog) Object.assign(meta, { cog: cog.file, cogSaved: cog.saved })
      const product = { ...meta,
        data: new Float32Array(buffers ? buffers.data : await readBin(dir, 'dem_data.bin')),
        mask: new Uint8Array(buffers ? buffers.mask : await readBin(dir, 'dem_mask.bin')),
      }
      validateProduct(kind, product)
      // The store turns `previewBlob` into the record's preview URL. A product saved
      // before the sidecar carried its preview inline as a data URL.
      const { previewDataUrl, ...rest } = product
      const previewBlob = buffers?.preview ? new Blob([buffers.preview], { type: 'image/png' })
        : (typeof previewDataUrl === 'string' ? dataUrlToBlob(previewDataUrl) : null)
      return previewBlob ? { ...rest, previewBlob } : rest
    } catch { return null }
  })
}

export async function deleteProduct(projectId, kind) {
  return trackPersistence('deleteProduct:' + String(projectId) + ':' + String(kind), () => persistenceLock(`product:${projectId}:${kind}`, async () => {
    const dir = await getSubDir(projectId, 'products')
    await dir.removeEntry(`${kind}.json`).catch(ignoreMissing)
    for (const suffix of ['_data.bin', '_mask.bin', '_rgba.bin']) {
      await dir.removeEntry(`${kind}${suffix}`).catch(ignoreMissing)
    }
    if (dir.keys) for await (const name of dir.keys()) {
      if (name.startsWith(`${kind}.json.`) && name.endsWith('.bin')) await dir.removeEntry(name).catch(ignoreMissing)
    }
  }))
}

export async function deleteProducts(projectId) {
  return trackPersistence('deleteProducts:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('products', { recursive: true })
    } catch (error) { ignoreMissing(error) }
  })
}

// Raster products (DEM, orthophoto).
import { trackPersistence, persistenceLock, ignoreMissing } from '../persistence.js'
import { writeBinaryDocument, readBinaryDocument } from '../binaryDocument.js'
import { dataUrlToBlob } from '../../core/mask.js'
import { getProjectDir, getSubDir, readBin, readJson, writeBin, writeJson } from './base.js'

// ── Products (DEM / orthophoto rasters) ──────────────────────────────────────
// Recomputable but expensive, so persisted like other project data. Metadata
// (dimensions, geotransform, CRS) goes in products/{id}.json, one document per
// product (a project may hold several DEMs and orthophotos; the record's `id`, or its
// kind for a record without one); the binary parts
// are generation files of that document (binaryDocument.js), the preview PNG among
// them. DEM: Float32 heights (`data`) + Uint8 validity (`mask`), read at open (≤ 4,096²),
// and Uint8 direct support (`support`, 0–255 measured share; absent on older DEMs);
// a DEM finer than that (SAT-3) also has its full grid as a Float32 COG (`cog`), kept
// like the ortho's, and `data`/`mask` are that COG's overview.
// Ortho: its Cloud-Optimized GeoTIFF (`cog`, RGBA, any size) — opened as a File
// handle at load, never read: the viewer and the map pull its tiles, exports copy or
// stream it. Its record carries `cogSaved` ({ name, bytes }, the committed file),
// which the next save of the same ortho (a rename) reuses instead of rewriting GBs.

function validateProduct(kind, product) {
  const n = product.width * product.height
  if (
    !Number.isSafeInteger(product.width) ||
    product.width <= 0 ||
    !Number.isSafeInteger(product.height) ||
    product.height <= 0 ||
    !Number.isSafeInteger(n) ||
    (kind === 'dem'
      ? !(product.data instanceof Float32Array) ||
        product.data.length !== n ||
        !(product.mask instanceof Uint8Array) ||
        product.mask.length !== n ||
        (product.support != null && (!(product.support instanceof Uint8Array) || product.support.length !== n))
      : !(product.cog instanceof Blob) && !product.cogSaved)
  ) {
    throw new Error('Incomplete or invalid raster product')
  }
}

// → the committed { key: { name, bytes } } files (the store records the ortho's cog).
export async function saveProduct(projectId, kind, product) {
  const stem = product.id ?? kind
  return trackPersistence('saveProduct:' + String(projectId) + ':' + String(stem), async () => {
    validateProduct(kind, product)
    return persistenceLock(`product:${projectId}:${stem}`, async () => {
      const dir = await getSubDir(projectId, 'products')
      // The preview PNG is a sidecar file (a Blob, written as is), never a string in
      // the JSON: a 4096² preview was ~100 MB of base64 parsed back at every open.
      const { data, mask, support, cog, cogSaved, previewBlob, previewUrl: _url, ...meta } = product
      // Pass views, not their underlying buffer: subarrays may have a nonzero offset.
      const cogPart = cogSaved ? { reuse: cogSaved } : cog
      const buffers =
        kind === 'dem'
          ? { data, mask, ...(support ? { support } : {}), ...(cogPart ? { cog: cogPart } : {}) }
          : { cog: cogPart }
      buffers.preview = previewBlob ?? null
      let res = await writeBinaryDocument(dir, `${stem}.json`, meta, buffers, { writeJson, writeBin })
      // The reused file went missing (another tab's save collected it): write it out.
      if (res.stale && cog instanceof Blob) {
        res = await writeBinaryDocument(dir, `${stem}.json`, meta, { ...buffers, cog }, { writeJson, writeBin })
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
// `stem`: the document's name, the product's id (its kind for one saved without).
export async function loadProduct(projectId, kind, stem = kind) {
  return persistenceLock(`product:${projectId}:${stem}`, async () => {
    try {
      const dir = await getSubDir(projectId, 'products')
      const meta = await readJson(dir, `${stem}.json`)
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
      const buffers = meta.binaryFiles
        ? await readBinaryDocument(dir, { ...meta, binaryFiles: planeFiles }, readBin)
        : null
      delete meta.binaryFiles
      if (cog) Object.assign(meta, { cog: cog.file, cogSaved: cog.saved })
      const product = {
        ...meta,
        data: new Float32Array(buffers ? buffers.data : await readBin(dir, 'dem_data.bin')),
        mask: new Uint8Array(buffers ? buffers.mask : await readBin(dir, 'dem_mask.bin')),
        ...(buffers?.support ? { support: new Uint8Array(buffers.support) } : {}),
      }
      validateProduct(kind, product)
      // The store turns `previewBlob` into the record's preview URL. A product saved
      // before the sidecar carried its preview inline as a data URL.
      const { previewDataUrl, ...rest } = product
      const previewBlob = buffers?.preview
        ? new Blob([buffers.preview], { type: 'image/png' })
        : typeof previewDataUrl === 'string'
          ? dataUrlToBlob(previewDataUrl)
          : null
      return previewBlob ? { ...rest, previewBlob } : rest
    } catch {
      return null
    }
  })
}

// `stem`: the product's id, as for loadProduct.
export async function deleteProduct(projectId, stem) {
  return trackPersistence('deleteProduct:' + String(projectId) + ':' + String(stem), () =>
    persistenceLock(`product:${projectId}:${stem}`, async () => {
      const dir = await getSubDir(projectId, 'products')
      await dir.removeEntry(`${stem}.json`).catch(ignoreMissing)
      for (const suffix of ['_data.bin', '_mask.bin', '_rgba.bin']) {
        await dir.removeEntry(`${stem}${suffix}`).catch(ignoreMissing)
      }
      if (dir.keys)
        for await (const name of dir.keys()) {
          if (name.startsWith(`${stem}.json.`) && name.endsWith('.bin'))
            await dir.removeEntry(name).catch(ignoreMissing)
        }
    }),
  )
}

// Every saved product, oldest first: [{ stem, product }], `product` being what
// loadProduct returns for it ({ outdated: true } for an ortho in the old format).
// The kind is the record's own, or the stem's for a document saved before records
// carried one ('dem.json', 'ortho.json').
export async function loadProducts(projectId) {
  let stems = []
  try {
    const dir = await getSubDir(projectId, 'products')
    if (dir.keys)
      for await (const name of dir.keys()) {
        if (name.endsWith('.json') && !name.includes('.json.')) stems.push(name.slice(0, -'.json'.length))
      }
  } catch {
    return []
  }
  const kindOf = (stem) => (stem === 'ortho' || stem.startsWith('ortho-') ? 'ortho' : 'dem')
  const out = []
  for (const stem of stems) {
    const product = await loadProduct(projectId, kindOf(stem), stem)
    if (product) out.push({ stem, product })
  }
  return out.sort((a, b) => (a.product.createdAt ?? 0) - (b.product.createdAt ?? 0))
}

export async function deleteProducts(projectId) {
  return trackPersistence('deleteProducts:' + String(projectId), async () => {
    try {
      const dir = await getProjectDir(projectId)
      await dir.removeEntry('products', { recursive: true })
    } catch (error) {
      ignoreMissing(error)
    }
  })
}

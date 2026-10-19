import { resolveOrthoStyle, isDefaultOrthoStyle, resolveDemStyle, describeDemStyle } from '../../core/products/productStyle.js'
import { demPreview as workerDemPreview } from '../../workers/computeClient.js'
import * as opfs from '../../utils/opfs.js'
import { productMapBlocker } from '../../core/products/productLayers.js'

// The computed raster products (one DEM, one orthophoto) as records, split out of
// useReconstructionStore: renaming, symbology, their map-layer state, saving and
// removal. Generating them is reconstruction/productRuns.js.
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createProducts({
  dem, isPersisting, log, ortho, save, productLayers, projects, withPreviewUrl,
}) {
  function productForKind(kind) {
    if (kind === 'dem') return dem.value
    if (kind === 'ortho') return ortho.value
    return null
  }

  // Computed raster products have stable kind-based identities (one DEM and one
  // orthophoto), so their user-facing names can change independently of every
  // consumer. Replacing the shallow-ref object also updates sidebar/viewer users.
  function renameProduct(kind, name) {
    const product = productForKind(kind)
    const trimmed = name?.trim()
    if (!product || !trimmed || trimmed === product.name) return false
    const previous = product.name || (kind === 'ortho' ? 'Orthophoto' : 'DEM')
    const renamed = { ...product, name: trimmed }
    if (kind === 'dem') dem.value = renamed
    else ortho.value = renamed
    log(`Renamed product "${previous}" → "${trimmed}"`, 'info', 'Products', { channel: 'activity' })
    saveProductRecord(kind, renamed)
    return true
  }

  // Products ▸ Symbology… — display only (core/products/productStyle.js). An ortho's
  // adjustments apply at draw time, so the record just carries them; a DEM's preview
  // PNG is re-baked from its heights in the worker, and the record (with its new
  // preview URL) replaces the old one only if the DEM was not rebuilt meanwhile AND
  // no newer style was applied since: two quick Applies bake concurrently, and the
  // older one finishing last must not overwrite the newer (per-kind sequence token).
  const productStyleSeq = { dem: 0, ortho: 0 }
  async function setProductStyle(kind, style) {
    const product = productForKind(kind)
    if (!product) return false
    const seq = ++productStyleSeq[kind]
    const label = product.name || (kind === 'ortho' ? 'Orthophoto' : 'DEM')
    if (kind === 'ortho') {
      const next = resolveOrthoStyle(style)
      const { style: _old, ...rest } = product
      ortho.value = isDefaultOrthoStyle(next) ? rest : { ...rest, style: next }
      log(`${label}: brightness ${next.brightness}, contrast ${next.contrast}, gamma ${next.gamma}`,
        'info', 'Products', { channel: 'activity' })
      saveProductRecord('ortho', ortho.value)
      return true
    }
    const next = resolveDemStyle(style)
    try {
      const { previewBlob } = await workerDemPreview({ style: next, grid: {
        width: product.width, height: product.height, data: product.data, mask: product.mask,
        gsd: product.gsd, zMin: product.zMin, zMax: product.zMax,
      } })
      if (seq !== productStyleSeq.dem || dem.value?.createdAt !== product.createdAt) return false
      const { previewUrl: _url, ...rest } = dem.value
      dem.value = withPreviewUrl({ ...rest, style: next, previewBlob })
      log(`${label}: ${describeDemStyle(next, product)}`, 'info', 'Products', { channel: 'activity' })
      saveProductRecord('dem', dem.value)
      return true
    } catch (err) {
      // A superseded bake's failure is moot — the newer Apply reports its own.
      if (seq === productStyleSeq.dem) log(`${label} symbology failed: ${err?.message ?? err}`, 'error', 'Products')
      return false
    }
  }

  // Persist a DEM/ortho. A record with a COG (every ortho; a DEM past one plane) is
  // then pointed at the committed file (if it is still the current product), so the
  // worker's in-memory Blob can go and the next save reuses the file instead of
  // rewriting it.
  // Only the LATEST save may do that: an earlier one's file is collected by the next.
  const productSaveSeq = { dem: 0, ortho: 0 }
  function saveProductRecord(kind, record) {
    if (!isPersisting()) return
    const projectId = projects.currentProjectId, seq = ++productSaveSeq[kind]
    opfs.saveProduct(projectId, kind, record).then((saved) => {
      if (!saved?.cogSaved || seq !== productSaveSeq[kind] || projectId !== projects.currentProjectId) return
      const target = kind === 'ortho' ? ortho : dem
      const now = target.value
      if (now && now.createdAt === record.createdAt) target.value = { ...now, cog: saved.cog, cogSaved: saved.cogSaved }
    }).catch(() => {})
  }

  // Show/hide a computed DEM/ortho on the map. Refused (logged, false) when the
  // product cannot be placed — the ribbon and sidebar grey the toggle for the same
  // reason, from the same productMapBlocker.
  function setProductVisible(kind, visible) {
    const product = productForKind(kind)
    const blocker = visible ? productMapBlocker(product) : null
    if (blocker) { log(`Map: ${blocker}`, 'warn', 'Products'); return false }
    const prev = productLayers.value[kind] ?? { visible: false, opacity: 1 }
    if (prev.visible === !!visible) return true
    productLayers.value = { ...productLayers.value, [kind]: { ...prev, visible: !!visible } }
    log(`${product?.name || (kind === 'ortho' ? 'Orthophoto' : 'DEM')} ${visible ? 'shown on' : 'hidden from'} the map`,
      'info', 'Products', { channel: 'activity' })
    save()
    return true
  }
  function setProductOpacity(kind, opacity) {
    const prev = productLayers.value[kind] ?? { visible: false, opacity: 1 }
    const next = Math.min(1, Math.max(0, Number(opacity)))
    if (!Number.isFinite(next) || next === prev.opacity) return
    productLayers.value = { ...productLayers.value, [kind]: { ...prev, opacity: next } }
    save()
  }

  async function removeProduct(kind) {
    const product = productForKind(kind)
    if (!product) return false
    const name = product.name || (kind === 'ortho' ? 'Orthophoto' : 'DEM')
    if (kind === 'dem') dem.value = null
    else ortho.value = null
    // A product built later starts off the map rather than inheriting this one's flag.
    if (productLayers.value[kind]?.visible) {
      productLayers.value = { ...productLayers.value, [kind]: { ...productLayers.value[kind], visible: false } }
      save()
    }
    if (isPersisting()) await opfs.deleteProduct(projects.currentProjectId, kind).catch(() => {})
    log(`Removed product "${name}"`, 'info', 'Products', { channel: 'activity' })
    return true
  }

  return {
    productForKind, renameProduct, setProductStyle, saveProductRecord, setProductVisible,
    setProductOpacity, removeProduct, productSaveSeq,
  }
}

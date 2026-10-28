import {
  resolveOrthoStyle,
  isDefaultOrthoStyle,
  resolveDemStyle,
  describeDemStyle,
} from '../../core/products/productStyle.js'
import { demPreview as workerDemPreview } from '../../workers/computeClient.js'
import * as opfs from '../../utils/opfs.js'
import { productMapBlocker } from '../../core/products/productLayers.js'

// The computed raster products (DEMs and orthophotos, several of each, one of each
// kind the main one) as records, split out of useReconstructionStore: renaming,
// symbology, the main product, their map-layer state, saving and removal. Generating
// them is reconstruction/productRuns.js.
//
// The map layer and the product tab show the MAIN product of a kind, as Metashape
// shows its default DEM and orthomosaic; `productLayers` is keyed by kind for that.
//
// Deps are the store's own refs and helpers; the store keeps the state.
export function createProducts({
  rasterProducts,
  mainProductIds,
  dem,
  ortho,
  isPersisting,
  log,
  save,
  productLayers,
  projects,
  withPreviewUrl,
}) {
  const fallbackName = (kind) => (kind === 'ortho' ? 'Orthophoto' : 'DEM')
  const productById = (id) => rasterProducts.value.find((p) => p.id === id) ?? null
  function productForKind(kind) {
    if (kind === 'dem') return dem.value
    if (kind === 'ortho') return ortho.value
    return null
  }
  // Swap one record for its new version (a new object, so shallow-ref users update).
  function replaceRecord(next) {
    rasterProducts.value = rasterProducts.value.map((p) => (p.id === next.id ? next : p))
  }

  // Names are labels only: tabs, layers and files key off the id (or, for what the
  // map and the tab show, the kind's main product).
  function renameProduct(id, name) {
    const product = productById(id)
    const trimmed = name?.trim()
    if (!product || !trimmed || trimmed === product.name) return false
    const previous = product.name || fallbackName(product.kind)
    const renamed = { ...product, name: trimmed }
    replaceRecord(renamed)
    log(`Renamed product "${previous}" → "${trimmed}"`, 'info', 'Products', { channel: 'activity' })
    saveProductRecord(renamed)
    return true
  }

  // Right-click ▸ Set as main: what the map, the product tab and the next build use.
  function setMainProduct(id) {
    const product = productById(id)
    if (!product || mainProductIds.value[product.kind] === id) return false
    mainProductIds.value = { ...mainProductIds.value, [product.kind]: id }
    log(`Main ${product.kind === 'ortho' ? 'orthophoto' : 'DEM'} → "${product.name}"`, 'info', 'Products', {
      channel: 'activity',
    })
    save()
    return true
  }

  // Products ▸ Symbology… — display only (core/products/productStyle.js). An ortho's
  // adjustments apply at draw time, so the record just carries them; a DEM's preview
  // PNG is re-baked from its heights in the worker, and the record (with its new
  // preview URL) replaces the old one only if the DEM was not rebuilt meanwhile AND
  // no newer style was applied since: two quick Applies bake concurrently, and the
  // older one finishing last must not overwrite the newer (per-product sequence token).
  const productStyleSeq = new Map()
  async function setProductStyle(id, style) {
    const product = productById(id)
    if (!product) return false
    const seq = (productStyleSeq.get(id) ?? 0) + 1
    productStyleSeq.set(id, seq)
    const label = product.name || fallbackName(product.kind)
    if (product.kind === 'ortho') {
      const next = resolveOrthoStyle(style)
      const { style: _old, ...rest } = product
      const styled = isDefaultOrthoStyle(next) ? rest : { ...rest, style: next }
      replaceRecord(styled)
      log(
        `${label}: brightness ${next.brightness}, contrast ${next.contrast}, gamma ${next.gamma}`,
        'info',
        'Products',
        { channel: 'activity' },
      )
      saveProductRecord(styled)
      return true
    }
    const next = resolveDemStyle(style)
    try {
      const { previewBlob } = await workerDemPreview({
        style: next,
        grid: {
          width: product.width,
          height: product.height,
          data: product.data,
          mask: product.mask,
          gsd: product.gsd,
          zMin: product.zMin,
          zMax: product.zMax,
        },
      })
      const now = productById(id)
      if (seq !== productStyleSeq.get(id) || now?.createdAt !== product.createdAt) return false
      const { previewUrl: _url, ...rest } = now
      const styled = withPreviewUrl({ ...rest, style: next, previewBlob })
      replaceRecord(styled)
      log(`${label}: ${describeDemStyle(next, product)}`, 'info', 'Products', { channel: 'activity' })
      saveProductRecord(styled)
      return true
    } catch (err) {
      // A superseded bake's failure is moot — the newer Apply reports its own.
      if (seq === productStyleSeq.get(id)) log(`${label} symbology failed: ${err?.message ?? err}`, 'error', 'Products')
      return false
    }
  }

  // Persist a DEM/ortho. A record with a COG (every ortho; a DEM past one plane) is
  // then pointed at the committed file (if it is still the same build), so the
  // worker's in-memory Blob can go and the next save reuses the file instead of
  // rewriting it.
  // Only the LATEST save of a product may do that: an earlier one's file is collected
  // by the next.
  const productSaveSeq = new Map()
  function saveProductRecord(record) {
    if (!isPersisting()) return
    const projectId = projects.currentProjectId
    const seq = (productSaveSeq.get(record.id) ?? 0) + 1
    productSaveSeq.set(record.id, seq)
    opfs
      .saveProduct(projectId, record.kind, record)
      .then((saved) => {
        if (!saved?.cogSaved || seq !== productSaveSeq.get(record.id) || projectId !== projects.currentProjectId) return
        const now = productById(record.id)
        if (now && now.createdAt === record.createdAt)
          replaceRecord({ ...now, cog: saved.cog, cogSaved: saved.cogSaved })
      })
      .catch(() => {})
  }

  // Show/hide the main DEM/ortho on the map. Refused (logged, false) when the
  // product cannot be placed — the ribbon and sidebar grey the toggle for the same
  // reason, from the same productMapBlocker.
  function setProductVisible(kind, visible) {
    const product = productForKind(kind)
    const blocker = visible ? productMapBlocker(product) : null
    if (blocker) {
      log(`Map: ${blocker}`, 'warn', 'Products')
      return false
    }
    const prev = productLayers.value[kind] ?? { visible: false, opacity: 1 }
    if (prev.visible === !!visible) return true
    productLayers.value = { ...productLayers.value, [kind]: { ...prev, visible: !!visible } }
    log(`${product?.name || fallbackName(kind)} ${visible ? 'shown on' : 'hidden from'} the map`, 'info', 'Products', {
      channel: 'activity',
    })
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

  // Removing the main product makes the newest one left of its kind the main one
  // (core/products/productSet.js mainOf), which then takes its place on the map.
  async function removeProduct(id) {
    const product = productById(id)
    if (!product) return false
    const { kind } = product
    const name = product.name || fallbackName(kind)
    rasterProducts.value = rasterProducts.value.filter((p) => p.id !== id)
    // The last of its kind: one built later starts afresh rather than inheriting
    // this one's layer state, and goes on the map as a first build does.
    const lastOfKind = !rasterProducts.value.some((p) => p.kind === kind)
    if (lastOfKind && productLayers.value[kind]) {
      const { [kind]: _removed, ...rest } = productLayers.value
      productLayers.value = rest
    }
    if (mainProductIds.value[kind] === id) {
      const { [kind]: _main, ...rest } = mainProductIds.value
      mainProductIds.value = rest
    }
    save()
    if (isPersisting()) await opfs.deleteProduct(projects.currentProjectId, id).catch(() => {})
    log(`Removed product "${name}"`, 'info', 'Products', { channel: 'activity' })
    return true
  }

  return {
    productById,
    productForKind,
    renameProduct,
    setMainProduct,
    setProductStyle,
    saveProductRecord,
    setProductVisible,
    setProductOpacity,
    removeProduct,
    productSaveSeq,
  }
}

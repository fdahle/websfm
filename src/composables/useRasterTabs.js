import { computed, reactive } from 'vue'
import { storeToRefs } from 'pinia'
import { useExternalStore } from '../stores/useExternalStore.js'
import { useImagesStore } from '../stores/useImagesStore.js'
import { useModalsStore } from '../stores/useModalsStore.js'
import { useProjectsStore } from '../stores/useProjectsStore.js'
import { useReconstructionStore } from '../stores/useReconstructionStore.js'
import { productMapBlocker } from '../core/products/productLayers.js'
import * as opfs from '../utils/opfs.js'
import { askConfirm } from './useConfirmations.js'
import { useLog } from './useLog.js'

// Raster tabs, lifted out of App.vue: the computed DEM / orthophoto and imported
// reference rasters as tabs (open, rename, remove, style), the raster in front for
// the ribbon's contextual tab, and moving a TIFF between the source images and the
// reference data in either direction.
//
// Injected: `tabs` (useTabs' functions; `openRasterTabRaw` is its openRasterTab),
// `openRasterImport` (useImportRouting — a converted image re-enters the raster import).
export function useRasterTabs({ tabs, openRasterImport }) {
  const { activeTab, openProductTab, openRasterTabRaw, closeTab, closeTabForRaster, closeTabForImage, setTabTitle } = tabs
  const { log } = useLog()
  const { currentProjectId } = storeToRefs(useProjectsStore())
  const imagesStore = useImagesStore()
  const { imageById, addImages, removeImage } = imagesStore
  const reconstructionStore = useReconstructionStore()
  const { dem, ortho, productLayers } = storeToRefs(reconstructionStore)
  const { removeProduct, renameProduct } = reconstructionStore
  const externalStore = useExternalStore()
  const { rasterById, renameRaster, removeRaster, setRasterStyle } = externalStore
  const { importRasterOpen, importRasterData, rasterStyleId } = storeToRefs(useModalsStore())

  function computedProductName(kind) {
    const product = kind === 'ortho' ? ortho.value : dem.value
    return product?.name || (kind === 'ortho' ? 'Orthophoto' : 'DEM')
  }

  function openComputedProductTab(kind) {
    openProductTab(kind, computedProductName(kind))
  }

  function renameProductFromSidebar({ kind, name }) {
    if (renameProduct(kind, name)) setTabTitle(`product:${kind}`, computedProductName(kind))
  }

  async function renameRasterFromSidebar({ id, name }) {
    const trimmed = name?.trim()
    if (!trimmed || !(await renameRaster(id, trimmed))) return
    setTabTitle(`raster:${id}`, trimmed)
  }


  function confirmRemoveProduct(kind) {
    const name = computedProductName(kind)
    askConfirm({
      title: `Remove ${kind === 'ortho' ? 'orthophoto' : 'DEM'}?`,
      message: `Remove “${name}”? The product can be rebuilt, but this can't be undone.`,
      onConfirm: async () => {
        closeTab(`product:${kind}`)
        await removeProduct(kind)
      },
    })
  }


  // Open an imported reference raster in its own tab. The tab opens immediately
  // (the preview PNG is in the index, so there's something to look at at once) and
  // the full plane hydrates behind it — a REMA tile is hundreds of MB and must not
  // block the tab switch.
  function openRasterTab(id) {
    const meta = externalStore.rasterById(id)
    if (!meta) return
    openRasterTabRaw(id, meta.name)
    externalStore.ensureRasterLoaded(id)
  }

  // The import modal's escape hatch: the geokey sniff said "reference raster" but
  // this really is a source photo (a georeferenced aerial frame is unusual, not
  // impossible — and a scan carrying a degenerate identity geotransform trips it).
  // Pull the original back out, hand it to the image ingest, and drop the
  // reference-data record.
  //
  // Via the store, NOT opfs directly: `external/{id}.src` is only written when the
  // project persists, so in a non-persisting project the sole copy is the in-memory
  // one the store holds — reading OPFS here made the escape hatch fail on exactly
  // the freshly-imported raster the user was trying to rescue.
  async function onRasterImportAsImage({ id }) {
    const meta = externalStore.rasterById(id)
    if (!meta) return
    importRasterOpen.value = false
    importRasterData.value = null
    const file = await externalStore.originalFile(id)
    if (!file) {
      log(`Could not re-read "${meta.name}" to import it as an image — re-add the file.`, 'warn', 'Import')
      return
    }
    // Reachable from the Reference Data right-click too, where the raster may have
    // an open tab — it would otherwise linger showing an empty viewer.
    closeTabForRaster(id)
    await removeRaster(id)
    addImages([new File([file], meta.name, { type: 'image/tiff' })])
  }

  // The mirror of onRasterImportAsImage: a GeoTIFF that the ingest-time geokey
  // sniff sent down the source-photo path (tags written in a form geotiff.js
  // couldn't read, or absent when the user expected them). Re-read the original
  // TIFF out of OPFS, import it as a reference raster, and drop the image entry —
  // but ONLY if the raster import actually succeeded, so a file with no
  // geotransform stays where it is instead of vanishing from both sections.
  async function convertImageToRaster(imageId) {
    const img = imageById(imageId)
    if (!img) return
    askConfirm({
      title: 'Convert to reference data?',
      message: `Re-import “${img.name}” as an imported DEM / orthophoto? It is removed from `
        + 'the source images, along with its keypoints, mask, depth map and matches.',
      confirmLabel: 'Convert',
      onConfirm: async () => {
        // Two sources for the ORIGINAL TIFF, and both are needed: a freshly added
        // image still holds its File in memory (and in a non-persisting project
        // that is the ONLY copy — addImages only writes to OPFS when persisting),
        // while a restored image has `file: null` and lives in OPFS. Note the OPFS
        // key is `uuid`, NOT `id` (which is name-size-lastModified) — getFileHandle
        // throws NotFoundError rather than returning null, so this must be caught.
        let file = img.file
        if (!file) {
          try {
            const blob = await opfs.loadImageBlob(currentProjectId.value, img.uuid)
            if (blob) file = new File([blob], img.sourceName ?? img.name, { type: 'image/tiff' })
          } catch { /* fall through to the warning below */ }
        }
        if (!file) {
          log(`Could not re-read “${img.name}” to convert it — re-add the file.`, 'warn', 'Import')
          return
        }
        // alwaysConfirm: the auto-sniff already declined this file once, so its
        // DEM-vs-ortho guess has not earned a silent import here.
        const record = await openRasterImport(file, { alwaysConfirm: true })
        if (!record) return // importRaster already logged why; keep the image
        removeImage(imageId, closeTabForImage)
      },
    })
  }

  // The raster the Style modal is editing, resolved live from the store: a
  // restyle replaces the record, so holding the object would leave the modal
  // showing the pre-restyle preview.
  const rasterBeingStyled = computed(() =>
    rasterStyleId.value ? externalStore.rasterById(rasterStyleId.value) : null)

  async function onRasterStyleApply({ id, style }) {
    rasterStyleId.value = null
    await setRasterStyle(id, style)
  }


  // ── Raster tabs (DEM / orthophoto / imported reference) ───────────────────────
  // One ProductViewer ref per open raster tab, for the Ribbon's contextual tab to
  // drive fit/zoom imperatively (mirrors imageViewerRefs).
  const productViewerRefs = reactive({})

  // The raster tab in front, if any — the Ribbon's contextual-tab trigger and the
  // target of every `raster-*` command. A computed product has no id/name of its
  // own; an imported one carries its record so the tab can label + restyle it.
  const activeRasterTab = computed(() => {
    const tab = activeTab.value
    // `measure` is the viewer's measurement-tool state (RasterMeasurements), read
    // through the tab's ProductViewer ref so the Ribbon's Measure group can show it.
    const measure = tab ? productViewerRefs[tab.id]?.measureState ?? null : null
    if (tab?.type === 'product') {
      const product = tab.productKind === 'ortho' ? ortho.value : dem.value
      return { tabId: tab.id, kind: tab.productKind, imported: false, name: tab.title, measure,
        visible: !!productLayers.value[tab.productKind]?.visible, mapBlocked: productMapBlocker(product) }
    }
    if (tab?.type === 'raster') {
      const r = rasterById(tab.rasterId)
      return {
        tabId: tab.id,
        rasterId: tab.rasterId,
        kind: r?.kind ?? 'dem',
        imported: true,
        name: r?.name ?? 'Raster',
        visible: !!r?.visible,
        // Band math has something to choose (>3 bands or deeper than 8-bit).
        styleable: !!r?.styleable,
        measure,
      }
    }
    return null
  })


  function activeProductViewer() {
    const t = activeRasterTab.value
    return t ? productViewerRefs[t.tabId] ?? null : null
  }

  return {
    productViewerRefs, activeRasterTab, activeProductViewer,
    openComputedProductTab, renameProductFromSidebar, confirmRemoveProduct,
    openRasterTab, renameRasterFromSidebar, onRasterImportAsImage, convertImageToRaster,
    rasterBeingStyled, onRasterStyleApply,
  }
}

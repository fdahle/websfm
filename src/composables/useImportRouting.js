import { ref } from 'vue'
import { storeToRefs } from 'pinia'
import { useModalsStore } from '../stores/useModalsStore.js'
import { parseGeoJson, looksLikeGeoJson, geoJsonToGcps, guessNameKey } from '../core/io/geojson.js'
import { detectCameraMode } from '../core/io/cameraKind.js'
import { detectFileKind, isColmapFile } from '../core/io/importKind.js'
import { parseFiducialObs } from '../core/io/fiducialObs.js'
import { sniffCloudFormat } from '../core/io/cloudImport.js'
import { looksLikeZipHead, isProjectArchiveName } from '../core/io/projectArchive.js'
import { applyImportTransform } from '../core/io/cloudImport.js'
import { parseCloudFile as parseCloudFileWorker } from '../workers/computeClient.js'
import { unzipStore } from '../utils/zip.js'
import { peekArchiveManifest } from '../utils/projectFile.js'
import { isTiff, isGeoreferencedTiff, probeTiffGeoTags } from '../utils/tiff.js'
import { useLog } from './useLog.js'

// The dropped/picked-file import funnel, lifted out of App.vue. It drives the
// import-related modals (all state lives in useModalsStore, pulled in here) and
// commits parsed data through the injected store actions. Injected deps:
//   addGcps, addFootprints, addSensors, addPoses — store actions
//   activateTab(id) — switch the active tab (to 'map' after a spatial import)
// `cameraPickMode` is returned so the Ribbon command dispatch (still in App.vue)
// can hint the file-picker mode before opening the hidden <input>.
export function useImportRouting({ addGcps, addFootprints, addSensors, addPoses, addFiducialObs, importColmap, importCloud, importRaster, importProjectFile, addImages, activateTab }) {
  const {
    gcpImportOpen, gcpImportText, gcpImportName, gcpImportGeojson, gcpImportCrs,
    footprintImportOpen, footprintImportData,
    cameraImportOpen, cameraImportText, cameraImportName, cameraImportMode,
    importKindOpen, importKindFile,
    importCloudOpen, importCloudData,
    importRasterOpen, importRasterData,
  } = storeToRefs(useModalsStore())
  const { log } = useLog()

  // sensor | pose | null, set before opening the file picker (by the command dispatch).
  const cameraPickMode = ref(null)

  // ── Import (GCPs / footprints) ──────────────────────────────────────────────────
  // A delimited text file is always GCPs. A GeoJSON file is routed by geometry:
  // point features → GCP import, polygon features → footprint import.
  async function openImportFile(file) {
    if (!file) return
    let text
    try {
      text = await file.text()
    } catch (err) {
      console.error('Could not read import file', err)
      return
    }

    if (looksLikeGeoJson(file.name, text)) {
      const parsed = parseGeoJson(text)
      if (parsed.kind === 'polygons' || parsed.kind === 'mixed') {
        footprintImportData.value = {
          features: parsed.features,
          propertyKeys: parsed.propertyKeys,
          detectedCrs: parsed.sourceCrs,
          fileName: file.name,
        }
        footprintImportOpen.value = true
      }
      if (parsed.kind === 'points' || parsed.kind === 'mixed') {
        const nameKey = guessNameKey(parsed.propertyKeys)
        gcpImportGeojson.value = geoJsonToGcps(parsed.features, nameKey)
        gcpImportCrs.value = parsed.sourceCrs
        gcpImportName.value = file.name
        gcpImportOpen.value = true
      }
      return
    }

    // Delimited-text GCP file.
    gcpImportGeojson.value = null
    gcpImportCrs.value = null
    gcpImportText.value = text
    gcpImportName.value = file.name
    gcpImportOpen.value = true
  }

  // Sidebar drag-and-drop has no declared intent, so classify the dropped file and
  // route it: GCPs/footprints → GCP importer, poses/intrinsics → camera importer,
  // and anything ambiguous (a bare name + X/Y/Z list) → a small chooser.
  async function openDroppedImport(file) {
    if (!file) return
    // A `.websfm` project file is a whole *project*, not data to merge into the
    // open one, so it is checked first and short-circuits every other route. The
    // gate is magic bytes + a manifest peek, never the extension alone: a COLMAP
    // model also arrives as a `.zip`, and the manifest is what tells them apart.
    if (importProjectFile && await isProjectArchive(file)) { await importProjectFile(file); return }
    // A TIFF that reached the non-image path (no `image/tiff` MIME type, e.g. a
    // bare `.tif` from some file managers) still has to be checked for geokeys
    // before anything tries to decode it as text.
    if (importRaster && isTiff(file)) {
      if (await isGeoreferencedTiff(file)) { await openRasterImport(file); return }
      if (addImages) { addImages([file]); return } // a plain TIFF is a source photo
    }
    // Binary cloud formats (PLY/LAS) must be sniffed by magic bytes BEFORE any
    // text decode — decoding a 500 MB LAS as a string would blow up. Peek the head.
    try {
      const head = new Uint8Array(await file.slice(0, 8).arrayBuffer())
      const fmt = sniffCloudFormat(head, file.name)
      if (fmt === 'ply' || fmt === 'las') { openCloudImport(file); return }
    } catch { /* fall through to text routing */ }

    let text
    try {
      text = await file.text()
    } catch (err) {
      console.error('Could not read dropped file', err)
      return
    }
    routeImport(file, detectFileKind(text, file.name).kind)
  }

  // Cheap two-step: ZIP magic (4 bytes) then, only for a zip, the manifest peek
  // (a few kB). Never text-decodes, never reads the whole file.
  async function isProjectArchive(file) {
    try {
      const head = new Uint8Array(await file.slice(0, 4).arrayBuffer())
      if (!looksLikeZipHead(head)) return false
      if (isProjectArchiveName(file.name)) return true
      const manifest = await peekArchiveManifest(file)
      return !!manifest
    } catch {
      return false
    }
  }

  function routeImport(file, kind) {
    if (kind === 'pose' || kind === 'sensor') openCameraImport(file, kind)
    else if (kind === 'gcp' || kind === 'footprint') openImportFile(file)
    else if (kind === 'fiducialObs') openFiducialObsImport(file)
    else if (kind === 'colmap') openColmapImport([file])
    else if (kind === 'cloud') openCloudImport(file)
    else { importKindFile.value = file; importKindOpen.value = true }
  }

  // ── Import (georeferenced reference raster) ─────────────────────────────────
  //
  // ⚠ The routing conflict this solves: `useImagesStore` ingests ANY TIFF as a
  // source image, and a dropped `.tif` arrives with type `image/tiff`, so it
  // lands in the image path before any importer sees it. Every dropped/picked
  // image batch therefore gets forked here FIRST: a TIFF carrying GeoTIFF
  // geolocation tags is a reference raster, not a source photo. Aerial scans
  // carry no geokeys, so the split is clean in practice — and when it isn't, the
  // import modal offers "…or import as source image" as the escape hatch.
  //
  // Returns the files that really are source images, for the caller to ingest.
  async function forkGeoreferencedRasters(files) {
    const photos = []
    for (const file of [...(files || [])]) {
      if (importRaster && isTiff(file)) {
        const probe = await probeTiffGeoTags(file)
        if (probe.georeferenced) {
          await openRasterImport(file)
          continue
        }
        // Not georeferenced ⇒ source photo. Say so, with the tags that were
        // missing: this is the branch that surprises people (a GeoTIFF written
        // without a pixel scale, or one geotiff.js can't parse, becomes a very
        // confused source image), and the sidebar's "Convert to reference
        // data…" is the manual override for exactly this line.
        log(`${file.name}: ${probe.degenerate
          ? 'placeholder GeoTIFF tags (identity transform at origin 0,0, no CRS) — not georeferencing'
          : 'no GeoTIFF geolocation tags'}`
          + `${probe.error ? ` (header unreadable: ${probe.error})` : ''}`
          + ` [tiepoint ${probe.hasTiepoint ? 'yes' : 'no'},`
          + ` pixelscale ${probe.hasPixelScale ? 'yes' : 'no'},`
          + ` transformation ${probe.hasTransformation ? 'yes' : 'no'},`
          + ` crs ${probe.hasCrs ? 'yes' : 'no'}]`
          + ' — ingesting as a source image', 'info', 'Import')
      }
      photos.push(file)
    }
    return photos
  }

  // Dropped/picked image batch: fork the reference rasters out, ingest the rest.
  async function addImagesRouted(files) {
    const photos = await forkGeoreferencedRasters(files)
    if (photos.length && addImages) await addImages(photos)
  }

  // Decode + classify off-thread, then either commit straight away (the sniff
  // was decisive) or open the modal pre-selected to the guess.
  //
  // Confidence gating differs deliberately from `importKind.js`, which always
  // routes ambiguity to a modal: here a `high` verdict imports directly and
  // logs its reasons. That is only safe because the kind stays editable
  // afterwards ("Treat as DEM / orthophoto" on the Reference Data row) — without
  // that escape hatch a silent misclassification would be a delete-and-reimport.
  //
  // `alwaysConfirm` overrides that gating for the manual "Convert to reference
  // data…" path: the auto-sniff already declined that file once, so its verdict
  // has not earned a silent import however confident it sounds.
  //
  // Returns the raster record (null if the parse failed), so a caller that is
  // *moving* a file into reference data can tell whether the move succeeded
  // before deleting the source.
  async function openRasterImport(file, { forceKind = null, alwaysConfirm = false } = {}) {
    if (!file || !importRaster) return null
    const record = await importRaster(file, { forceKind })
    if (!record) return null

    if (alwaysConfirm || (!forceKind && record.classification?.confidence === 'low')) {
      // Ambiguous (a 1-band int16/uint16 resolved only by histogram, or by
      // filename alone) — show the user what it guessed and why, and let them
      // correct it before they build anything on top of it.
      importRasterData.value = { raster: record, fileName: file.name }
      importRasterOpen.value = true
    }
    activateTab('map')
    return record
  }

  function onRasterPick(event) {
    const file = event.target.files?.[0]
    if (file) openRasterImport(file)
    event.target.value = ''
  }

  // ── Import (point cloud / mesh) ─────────────────────────────────────────────
  // Parse the file off the main thread (the parseCloud worker op), then open the
  // settings modal with the parsed cloud + stats. The parse buffer is transferred
  // to the worker and back, so it never clones dense-scale data.
  async function openCloudImport(file) {
    if (!file || !importCloud) return
    try {
      const buffer = await file.arrayBuffer()
      const { parsed, stats } = await parseCloudFileWorker(buffer, file.name, {
        onLog: (m, l, c) => log(m, l, c),
      })
      importCloudData.value = { parsed, stats, fileName: file.name }
      importCloudOpen.value = true
    } catch (err) {
      log(`Cloud import: ${err?.message ?? err}`, 'error', 'Import')
    }
  }

  // User confirmed the cloud-import settings: apply the transform + commit.
  function onCloudImport(settings) {
    const data = importCloudData.value
    importCloudOpen.value = false
    importCloudData.value = null
    if (!data) return
    const transformed = applyImportTransform(data.parsed, { ...settings, onLog: (m, l, c) => log(m, l, c) })
    if (importCloud(transformed, data.fileName)) activateTab('viewer')
  }

  function onCloudPick(event) {
    const file = event.target.files?.[0]
    if (file) openCloudImport(file)
    event.target.value = ''
  }

  // COLMAP sparse model — a file *set*, so accept either a `.zip` or the loose
  // `cameras.{txt,bin}` / `images.{txt,bin}` / `points3D.{txt,bin}`
  // (case-insensitive, path-stripped). Text entries carry strings, binary entries
  // carry Uint8Array — the store's importColmapModel picks the parser by key
  // suffix. A model must not mix text + binary of the same table; the binary
  // variant wins when both appear (unlikely; a defensive tie-break).
  const COLMAP_CANON = {
    'cameras.txt': 'cameras.txt', 'images.txt': 'images.txt', 'points3d.txt': 'points3D.txt',
    'cameras.bin': 'cameras.bin', 'images.bin': 'images.bin', 'points3d.bin': 'points3D.bin',
  }
  async function openColmapImport(fileList) {
    const files = [...(fileList || [])]
    if (!files.length || !importColmap) return
    const model = {}
    try {
      const zip = files.find((f) => /\.zip$/i.test(f.name))
      const dec = new TextDecoder()
      // Binary entries stay bytes; text entries decode to a string.
      const add = (name, data) => {
        const key = COLMAP_CANON[String(name).split(/[\\/]/).pop().toLowerCase()]
        if (!key) return
        model[key] = key.endsWith('.bin') ? new Uint8Array(data) : (typeof data === 'string' ? data : dec.decode(data))
      }
      if (zip) {
        for (const e of unzipStore(new Uint8Array(await zip.arrayBuffer()))) add(e.name, e.data)
      } else {
        for (const f of files) if (isColmapFile(f.name)) add(f.name, await f.arrayBuffer())
      }
    } catch (err) {
      console.error('Could not read COLMAP model', err)
      return
    }
    if (importColmap(model)) activateTab('viewer')
  }

  // Fiducial-mark pixel observations (F4) commit directly — a row is (image,
  // fiducial, px, py) matched to an image by name, no CRS or column ambiguity
  // that would need a modal.
  async function openFiducialObsImport(file) {
    if (!file || !addFiducialObs) return
    let text
    try { text = await file.text() } catch (err) { console.error('Could not read fiducial file', err); return }
    const { rows } = parseFiducialObs(text)
    addFiducialObs(rows)
  }

  // User answered the "what is this file?" chooser.
  function onImportKindChosen(kind) {
    const file = importKindFile.value
    importKindOpen.value = false
    importKindFile.value = null
    if (file) routeImport(file, kind)
  }

  // User re-classified the file from inside an open import modal ("Import as …").
  function onImportSwitchKind({ kind, rawText, fileName }) {
    gcpImportOpen.value = false
    cameraImportOpen.value = false
    if (kind === 'gcp') {
      gcpImportGeojson.value = null
      gcpImportCrs.value = null
      gcpImportText.value = rawText
      gcpImportName.value = fileName
      gcpImportOpen.value = true
    } else {
      cameraImportText.value = rawText
      cameraImportName.value = fileName
      cameraImportMode.value = kind // 'pose' | 'sensor'
      cameraImportOpen.value = true
    }
  }

  async function onGcpImport({ gcps: parsed, sourceCrs }) {
    gcpImportOpen.value = false
    gcpImportGeojson.value = null
    await addGcps(parsed, sourceCrs)
    activateTab('map')
  }

  async function onFootprintImport({ footprints: parsed, sourceCrs, name }) {
    footprintImportOpen.value = false
    footprintImportData.value = null
    // Name the imported set after the file (strip extension) so the sidebar row
    // is recognisable; the store falls back to a generic label if absent.
    const setName = name ? name.replace(/\.[^.]+$/, '') : undefined
    await addFootprints(parsed, sourceCrs, setName)
    activateTab('map')
  }

  function onGcpPick(event) {
    const file = event.target.files?.[0]
    if (file) openImportFile(file)
    event.target.value = ''
  }

  // ── Import (camera intrinsics / extrinsics) ──────────────────────────────────────
  // A delimited camera file opens the import modal in the sniffed mode (sensor vs
  // pose); `forceMode` lets the Ribbon's two commands hint a default.
  async function openCameraImport(file, forceMode = null) {
    if (!file) return
    let text
    try {
      text = await file.text()
    } catch (err) {
      console.error('Could not read camera file', err)
      return
    }
    cameraImportText.value = text
    cameraImportName.value = file.name
    cameraImportMode.value = forceMode || detectCameraMode(text)
    cameraImportOpen.value = true
  }

  async function onCameraImport(payload) {
    cameraImportOpen.value = false
    if (payload.mode === 'sensor') {
      await addSensors(payload.sensors)
    } else {
      await addPoses(payload.poses, payload.sourceCrs)
      activateTab('map')
    }
  }

  function onCameraPick(event) {
    const file = event.target.files?.[0]
    if (file) openCameraImport(file, cameraPickMode.value)
    event.target.value = ''
  }

  function onColmapPick(event) {
    openColmapImport(event.target.files)
    event.target.value = ''
  }

  return {
    cameraPickMode,
    openImportFile, openDroppedImport, routeImport, isProjectArchive,
    openFiducialObsImport, openColmapImport,
    openCloudImport, onCloudImport, onCloudPick,
    openRasterImport, onRasterPick, forkGeoreferencedRasters, addImagesRouted,
    onImportKindChosen, onImportSwitchKind,
    openCameraImport, onCameraImport, onGcpImport, onFootprintImport,
    onGcpPick, onCameraPick, onColmapPick,
  }
}
